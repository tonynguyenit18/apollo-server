import { DurationHistogram } from './durationHistogram';
import {
  IStatsContext,
  Trace,
  TypeStat,
  QueryLatencyStats,
  IPathErrorStats,
} from 'apollo-engine-reporting-protobuf';

export class ContextualizedStats {
  statsContext: IStatsContext;
  queryLatencyStats: QueryLatencyStats;
  perTypeStat: { [k: string]: TypeStat };

  constructor(statsContext: IStatsContext) {
    this.statsContext = statsContext;
    this.queryLatencyStats = new QueryLatencyStats({
      latencyCount: new DurationHistogram(),
      requestCount: 0,
      cacheHits: 0,
      persistedQueryHits: 0,
      persistedQueryMisses: 0,
      cacheLatencyCount: new DurationHistogram(),
      rootErrorStats: Object.create(null),
      requestsWithErrorsCount: 0,
      publicCacheTtlCount: new DurationHistogram(),
      privateCacheTtlCount: new DurationHistogram(),
      registeredOperationCount: 0,
      forbiddenOperationCount: 0,
    });
    this.perTypeStat = Object.create(null);
  }

  public addTrace(trace: Trace) {
    const queryLatencyStats = this.queryLatencyStats;
    queryLatencyStats.requestCount++;
    if (trace.fullQueryCacheHit) {
      ((queryLatencyStats.cacheLatencyCount as unknown) as DurationHistogram).incrementDuration(
        trace.durationNs,
      );
      queryLatencyStats.cacheHits++;
    } else {
      ((queryLatencyStats.latencyCount as unknown) as DurationHistogram).incrementDuration(
        trace.durationNs,
      );
    }

    if (!trace.fullQueryCacheHit && trace.cachePolicy && trace.cachePolicy) {
      if (trace.cachePolicy.scope == Trace.CachePolicy.Scope.PRIVATE) {
        ((queryLatencyStats.privateCacheTtlCount as unknown) as DurationHistogram).incrementDuration(
          trace.cachePolicy.maxAgeNs || 0,
        );
      } else if (trace.cachePolicy.scope == Trace.CachePolicy.Scope.PUBLIC) {
        ((queryLatencyStats.publicCacheTtlCount as unknown) as DurationHistogram).incrementDuration(
          trace.cachePolicy.maxAgeNs || 0,
        );
      }
    }

    if (trace.persistedQueryHit) {
      queryLatencyStats.persistedQueryHits++;
    } else if (trace.persistedQueryRegister) {
      queryLatencyStats.persistedQueryMisses++;
    }

    if (trace.forbiddenOperation) {
      queryLatencyStats.forbiddenOperationCount++;
    } else if (trace.registeredOperation) {
      queryLatencyStats.registeredOperationCount++;
    }

    queryLatencyStats.requestsWithErrorsCount++;

    let hasError = false;
    const typeStats = this.perTypeStat;
    const rootPathErrorStats = queryLatencyStats.rootErrorStats as IPathErrorStats;

    function traceNodeStats(node: Trace.INode, path: ReadonlyArray<string>) {
      if (node.error && node.error.length > 0) {
        hasError = true;

        let currPathErrorStats: IPathErrorStats = rootPathErrorStats;

        for (const subPath of path.values()) {
          let children = currPathErrorStats.children;
          if (!children) {
            children = Object.create(null);
            currPathErrorStats.children = children;
          }

          // Children cannot be null or undefined be null or undefined
          let nextPathErrorStats = (children as {
            [k: string]: IPathErrorStats;
          })[subPath];
          if (!nextPathErrorStats) {
            nextPathErrorStats = Object.create(null)(
              children as { [k: string]: IPathErrorStats },
            )[subPath] = nextPathErrorStats;
          }

          // nextPathErrorStats be null or undefined
          currPathErrorStats = nextPathErrorStats as IPathErrorStats;
        }
        currPathErrorStats.requestsWithErrorsCount =
          (currPathErrorStats.requestsWithErrorsCount || 0) + 1;
        currPathErrorStats.errorsCount =
          (currPathErrorStats.errorsCount || 0) + node.error.length;
      }

      if (
        node.parentType &&
        node.originalFieldName &&
        node.type &&
        node.endTime &&
        node.startTime
      ) {
        let typeStat = typeStats[node.parentType];
        if (!typeStat) {
          typeStat = new TypeStat();
          typeStats[node.parentType] = typeStat;
        }

        let fieldStat = typeStat.perFieldStat[node.originalFieldName];
        const duration = node.endTime - node.startTime;
        if (!fieldStat) {
          const durationHistogram = new DurationHistogram();
          durationHistogram.incrementDuration(duration);
          fieldStat = {
            returnType: node.type,
            errorsCount: (node.error && node.error.length) || 0,
            count: 1,
            requestsWithErrorsCount:
              node.error && node.error.length > 0 ? 1 : 0,
            latencyCount: durationHistogram,
          };
          typeStat.perFieldStat[node.originalFieldName] = fieldStat;
        } else {
          // We only create the object in the above line so we can know they aren't null
          (fieldStat.errorsCount as number) =
            (node.error && node.error.length) || 0;
          (fieldStat.count as number)++;
          // Note: this is actually counting the number of resolver calls for this
          // field that had at least one error, not the number of overall GraphQL
          // queries that had at least one error for this field. That doesn't seem
          // to match the name, but it does match the Go engineproxy implementation.
          // (Well, actually the Go engineproxy implementation is even buggier because
          // it counts errors multiple times if multiple resolvers have the same path.)
          (fieldStat.requestsWithErrorsCount as number) +=
            node.error && node.error.length > 0 ? 1 : 0;
          ((fieldStat.latencyCount as unknown) as DurationHistogram).incrementDuration(
            duration,
          );
        }
      }
    }

    iterateOverTraceForStats(trace, traceNodeStats);
    if (hasError) {
      queryLatencyStats.requestsWithErrorsCount++;
    }
  }
}

/**
 * Iterates over the entire trace and add the error to the errorPathStats object if there are errors
 * Also returns true if there are any errors found so we can increment errorsCount
 * @param trace Trace wer are iterating over
 * @param f function to be run on every node of the trace
 */
function iterateOverTraceForStats(
  trace: Trace,
  f: (node: Trace.INode, path: ReadonlyArray<string>) => void,
): void {
  if (trace.root) {
    iterateOverTraceNode(trace.root, [], f);
  }

  if (trace.queryPlan) {
    iterateOverQueryPlan(trace.queryPlan, f);
  }
}

function iterateOverQueryPlan(
  node: Trace.IQueryPlanNode | null | undefined,
  f: (node: Trace.INode, path: ReadonlyArray<string>) => void,
): void {
  if (!node) return;

  if (
    node.fetch &&
    node.fetch.trace &&
    node.fetch.trace.root &&
    node.fetch.serviceName
  ) {
    iterateOverTraceNode(
      node.fetch.trace.root,
      [`service:${node.fetch.serviceName}`],
      f,
    );
  } else if (node.flatten) {
    iterateOverQueryPlan(node.flatten.node, f);
  } else if (node.parallel && node.parallel.nodes) {
    node.parallel.nodes.map(node => {
      iterateOverQueryPlan(node, f);
    });
  } else if (node.sequence && node.sequence.nodes) {
    node.sequence.nodes.map(node => {
      iterateOverQueryPlan(node, f);
    });
  }
}

function iterateOverTraceNode(
  node: Trace.INode,
  path: ReadonlyArray<string>,
  f: (node: Trace.INode, path: ReadonlyArray<string>) => void,
) {
  if (node.child) {
    for (const child of node.child) {
      let childPath = path;
      if (child.responseName) {
        // concat creates a new shallow copy of the array
        childPath = path.concat(child.responseName);
      }

      iterateOverTraceNode(node, childPath, f);
    }
  }
  f(node, path);
}
