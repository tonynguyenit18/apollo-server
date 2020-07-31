import { DurationHistogram } from './durationHistogram';
import {
  IFieldStat,
  IPathErrorStats,
  IQueryLatencyStats,
  IStatsContext,
  Trace,
  ITypeStat,
} from 'apollo-engine-reporting-protobuf';

export class QueryLatencyStats implements IQueryLatencyStats {
  latencyCount: DurationHistogram = new DurationHistogram();
  requestCount: number = 0;
  cacheHits: number = 0;
  persistedQueryHits: number = 0;
  persistedQueryMisses: number = 0;
  cacheLatencyCount: DurationHistogram = new DurationHistogram();
  rootErrorStats: IPathErrorStats = Object.create(null);
  requestsWithErrorsCount: number = 0;
  publicCacheTtlCount: DurationHistogram = new DurationHistogram();
  privateCacheTtlCount: DurationHistogram = new DurationHistogram();
  registeredOperationCount: number = 0;
  forbiddenOperationCount: number = 0;
}

export class TypeStat implements ITypeStat {
  perFieldStat: { [k: string]: FieldStat } = Object.create(null);
}

export class FieldStat implements IFieldStat {
  returnType: string;
  errorsCount: number = 0;
  count: number = 0;
  requestsWithErrorsCount: number = 0;
  latencyCount: DurationHistogram = new DurationHistogram();

  constructor(returnType: string) {
    this.returnType = returnType;
  }
}

export class ContextualizedStats {
  statsContext: IStatsContext;
  queryLatencyStats: QueryLatencyStats;
  perTypeStat: { [k: string]: TypeStat };

  constructor(statsContext: IStatsContext) {
    this.statsContext = statsContext;
    this.queryLatencyStats = new QueryLatencyStats();
    this.perTypeStat = Object.create(null);
  }

  public addTrace(trace: Trace) {
    const queryLatencyStats = this.queryLatencyStats;
    queryLatencyStats.requestCount++;
    if (trace.fullQueryCacheHit) {
      queryLatencyStats.cacheLatencyCount.incrementDuration(trace.durationNs);
      queryLatencyStats.cacheHits++;
    } else {
      queryLatencyStats.latencyCount.incrementDuration(trace.durationNs);
    }

    if (
      !trace.fullQueryCacheHit &&
      trace.cachePolicy &&
      trace.cachePolicy.maxAgeNs
    ) {
      if (trace.cachePolicy.scope == Trace.CachePolicy.Scope.PRIVATE) {
        queryLatencyStats.privateCacheTtlCount.incrementDuration(
          trace.cachePolicy.maxAgeNs,
        );
      } else if (trace.cachePolicy.scope == Trace.CachePolicy.Scope.PUBLIC) {
        queryLatencyStats.publicCacheTtlCount.incrementDuration(
          trace.cachePolicy.maxAgeNs,
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

    let hasError = false;
    const typeStats = this.perTypeStat;
    const rootPathErrorStats = queryLatencyStats.rootErrorStats;

    function traceNodeStats(node: Trace.INode, path: ReadonlyArray<string>) {
      // Generate error stats and error path information
      if (node.error && node.error.length > 0) {
        hasError = true;

        let currPathErrorStats = rootPathErrorStats;

        for (const subPathEntry of path.entries()) {
          // Using entries instead values since Node 8
          // doesn't support Array.prototype.values
          const subPath = subPathEntry[1];
          let children =
            currPathErrorStats.children ||
            (currPathErrorStats.children = Object.create(null));
          currPathErrorStats =
            children[subPath] || (children[subPath] = Object.create(null));
        }

        currPathErrorStats.requestsWithErrorsCount =
          (currPathErrorStats.requestsWithErrorsCount || 0) + 1;
        currPathErrorStats.errorsCount =
          (currPathErrorStats.errorsCount || 0) + node.error.length;
      }

      if (
        node.parentType != null &&
        node.originalFieldName != null &&
        node.type != null &&
        node.endTime != null &&
        node.startTime != null
      ) {
        let typeStat = typeStats[node.parentType];
        if (!typeStat) {
          typeStat = typeStats[node.parentType] = new TypeStat();
        }

        let fieldStat = typeStat.perFieldStat[node.originalFieldName];
        if (!fieldStat) {
          fieldStat = typeStat.perFieldStat[
            node.originalFieldName
          ] = new FieldStat(node.type);
        }

        // We only create the object in the above line so we can know they aren't null
        fieldStat.errorsCount = (node.error && node.error.length) || 0;
        fieldStat.count++;
        // Note: this is actually counting the number of resolver calls for this
        // field that had at least one error, not the number of overall GraphQL
        // queries that had at least one error for this field. That doesn't seem
        // to match the name, but it does match the Go engineproxy implementation.
        // (Well, actually the Go engineproxy implementation is even buggier because
        // it counts errors multiple times if multiple resolvers have the same path.)
        fieldStat.requestsWithErrorsCount +=
          node.error && node.error.length > 0 ? 1 : 0;
        fieldStat.latencyCount.incrementDuration(node.endTime - node.startTime);
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

      iterateOverTraceNode(child, childPath, f);
    }
  }
  f(node, path);
}
