import { DurationHistogram } from './durationHistogram';
import {
  IStatsContext,
  Trace,
  IPathErrorStats,
  ContextualizedStats as ContextualizedStatsProto,
  ITypeStat as TypeStatProto,
  IFieldStat as FieldStatProto,
} from 'apollo-engine-reporting-protobuf';

export interface FieldStat {
  returnType: string;
  errorsCount: number;
  count: number;
  requestsWithErrorsCount: number;
  latencyCount: DurationHistogram;
}

export interface QueryLatencyStats {
  readonly latencyCount: DurationHistogram;
  requestCount: number;
  cacheHits: number;
  persistedQueryHits: number;
  persistedQueryMisses: number;
  readonly cacheLatencyCount: DurationHistogram;
  readonly rootErrorStats: IPathErrorStats;
  requestsWithErrorCount: number;
  readonly publicCacheTtlCount: DurationHistogram;
  readonly privateCacheTtlCount: DurationHistogram;
  registeredOperationCount: number;
  forbiddenOperationCount: number;
}

export class ContextualizedStats {
  statsContext: IStatsContext;
  queryLatencyStats: QueryLatencyStats;
  perTypeStat: Map<string, Map<string, FieldStat>> = new Map<
    string,
    Map<string, FieldStat>
  >();

  constructor(statsContext: IStatsContext) {
    this.statsContext = statsContext;
    this.queryLatencyStats = {
      latencyCount: new DurationHistogram(),
      requestCount: 0,
      cacheHits: 0,
      persistedQueryHits: 0,
      persistedQueryMisses: 0,
      cacheLatencyCount: new DurationHistogram(),
      rootErrorStats: Object.create(null),
      requestsWithErrorCount: 0,
      publicCacheTtlCount: new DurationHistogram(),
      privateCacheTtlCount: new DurationHistogram(),
      registeredOperationCount: 0,
      forbiddenOperationCount: 0,
    };
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

    if (!trace.fullQueryCacheHit && trace.cachePolicy && trace.cachePolicy) {
      if (trace.cachePolicy.scope == Trace.CachePolicy.Scope.PRIVATE) {
        queryLatencyStats.privateCacheTtlCount.incrementDuration(
          trace.cachePolicy.maxAgeNs || 0,
        );
      } else if (trace.cachePolicy.scope == Trace.CachePolicy.Scope.PUBLIC) {
        queryLatencyStats.publicCacheTtlCount.incrementDuration(
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

    queryLatencyStats.requestsWithErrorCount++;

    let hasError = false;
    const typeStats = this.perTypeStat;
    const rootPathErrorStats = queryLatencyStats.rootErrorStats;

    function traceNodeStats(node: Trace.INode, path: ReadonlyArray<string>) {
      if (node.error && node.error.length > 0) {
        hasError = true;
        let currPathErrorStats = rootPathErrorStats;
        for (const subPath of path.values()) {
          if (!currPathErrorStats.children) {
            currPathErrorStats.children = Object.create(null);
          }

          // Ts doesn't seem to get that children isn't null after we set it???
          if (currPathErrorStats.children) {
            currPathErrorStats = currPathErrorStats.children[subPath];
          }
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
        let typeStat = typeStats.get(node.parentType);
        if (!typeStat) {
          typeStat = new Map<string, FieldStat>();
          typeStats.set(node.parentType, typeStat);
        }

        let fieldStat = typeStat.get(node.originalFieldName);
        const duration = node.endTime - node.startTime;
        if (!fieldStat) {
          const durationHistogram = new DurationHistogram();
          durationHistogram.incrementDuration(duration);
          fieldStat = {
            returnType: node.type,
            errorsCount: (node.error && node.error.length) || 0,
            count: 1,
            requestsWithErrorsCount: hasError ? 1 : 0,
            latencyCount: durationHistogram,
          };
          typeStat.set(node.originalFieldName, fieldStat);
        } else {
          fieldStat.errorsCount += (node.error && node.error.length) || 0;
          fieldStat.count++;
          fieldStat.requestsWithErrorsCount += hasError ? 1 : 0;
          fieldStat.latencyCount.incrementDuration(duration);
        }
      }
    }

    iterateOverTraceForStats(trace, traceNodeStats);
    if (hasError) {
      queryLatencyStats.requestsWithErrorCount++;
    }
  }

  toProto(): ContextualizedStatsProto {
    const queryLatencyStats = this.queryLatencyStats;
    const perTypeStat: { [k: string]: TypeStatProto } = Object.create(null);
    for (const type of this.perTypeStat.keys()) {
      const perFieldStat: {
        [k: string]: FieldStatProto | null;
      } = Object.create(null);
      const fieldMap = this.perTypeStat.get(type);

      // Should never hit this since we check it is in the list of keys
      if (!fieldMap) continue;

      const fields = fieldMap.keys();
      for (const field of fields) {
        const fieldStat = fieldMap.get(field);

        // Should never hit this since we check it is in the list of keys
        if (!fieldStat) continue;

        perFieldStat[field] = {
          returnType: fieldStat.returnType,
          requestsWithErrorsCount: fieldStat.requestsWithErrorsCount,
          errorsCount: fieldStat.errorsCount,
          latencyCount: fieldStat.latencyCount.toArray(),
          count: fieldStat.count,
        };
      }
      perTypeStat[type] = perFieldStat;
    }
    return new ContextualizedStatsProto({
      context: this.statsContext,
      queryLatencyStats: {
        latencyCount: queryLatencyStats.latencyCount.toArray(),
        requestCount: queryLatencyStats.requestCount,
        cacheHits: queryLatencyStats.cacheHits,
        persistedQueryHits: queryLatencyStats.persistedQueryHits,
        persistedQueryMisses: queryLatencyStats.persistedQueryMisses,
        cacheLatencyCount: queryLatencyStats.cacheLatencyCount.toArray(),
        rootErrorStats: queryLatencyStats.rootErrorStats,
        requestsWithErrorsCount: queryLatencyStats.requestsWithErrorCount,
        publicCacheTtlCount: queryLatencyStats.publicCacheTtlCount.toArray(),
        privateCacheTtlCount: queryLatencyStats.privateCacheTtlCount.toArray(),
        registeredOperationCount: queryLatencyStats.registeredOperationCount,
        forbiddenOperationCount: queryLatencyStats.forbiddenOperationCount,
      },
      perTypeStat: perTypeStat,
    });
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
    iterateOverTraceNode(node.fetch.trace.root, [node.fetch.serviceName], f);
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
