import {
  Trace,
} from 'apollo-engine-reporting-protobuf';
import { dateToProtoTimestamp } from "../treeBuilder";
import { ContextualizedStats } from "../contextualizedStats";
import { DurationHistogram } from "../durationHistogram";

describe('Check query latency stats when', () => {
  const statsContext =  {
    clientReferenceId: "reference",
    clientVersion: "version"
  }

  let baseDate = new Date();
  let nonFederatedTrace =  new Trace({
    startTime: dateToProtoTimestamp(baseDate),
    endTime: dateToProtoTimestamp(new Date(baseDate.getTime() + 30*1000)),
    durationNs: 30*1000,
    root: null,
    signature: "signature",
    details: null,
  });

  it('adding a single trace', () => {
    let contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(nonFederatedTrace);
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.latencyCount).toStrictEqual(new DurationHistogram().incrementDuration(30*1000));
    expect(contextualizedStats.queryLatencyStats.requestsWithErrorsCount).toBe(0);
  });
  it('adding a fully cached trace', () => {
    let contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(new Trace({
      ...nonFederatedTrace,
      fullQueryCacheHit: true
    }));
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.cacheHits).toBe(1);
    expect(contextualizedStats.queryLatencyStats.cacheLatencyCount).toStrictEqual(new DurationHistogram().incrementDuration(30*1000));
  });
  it('adding a public cached trace', () => {
    let contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(new Trace({
      ...nonFederatedTrace,
      fullQueryCacheHit: false,
      cachePolicy: {
        scope: Trace.CachePolicy.Scope.PRIVATE,
        maxAgeNs: 1000
      }
    }));
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.privateCacheTtlCount).toStrictEqual(new DurationHistogram().incrementDuration(1000));
  });
  it('adding a private cached trace', () => {
    let contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(new Trace({
      ...nonFederatedTrace,
      fullQueryCacheHit: false,
      cachePolicy: {
        scope: Trace.CachePolicy.Scope.PUBLIC,
        maxAgeNs: 1000
      }
    }));
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.publicCacheTtlCount).toStrictEqual(new DurationHistogram().incrementDuration(1000));
  });
  it('adding a persisted hit trace', () => {
    let contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(new Trace({
      ...nonFederatedTrace,
      persistedQueryHit: true
    }));
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.persistedQueryHits).toBe(1);
  });
  it('adding a persisted miss trace', () => {
    let contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(new Trace({
      ...nonFederatedTrace,
      persistedQueryRegister: true
    }));
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.persistedQueryMisses).toBe(1);
  });
  it('adding a forbidden trace', () => {
    let contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(new Trace({
      ...nonFederatedTrace,
      forbiddenOperation: true,
    }));
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.forbiddenOperationCount).toBe(1);
  });
  it('adding a registered trace', () => {
    let contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(new Trace({
      ...nonFederatedTrace,
      registeredOperation: true,
    }));
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.registeredOperationCount).toBe(1);
  });
  it('adding an errored trace ', () => {
    let contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(new Trace({
      ...nonFederatedTrace,
      registeredOperation: true,
      root: {
        child: [{
          responseName: "user",
          parentType: "Query",
          type: "User!",
          error: [{
            message: "error 1"
          }]
        }]
      }
    }));
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    console.log(contextualizedStats.queryLatencyStats.rootErrorStats);
    expect(contextualizedStats.queryLatencyStats.rootErrorStats.children["user"].requestsWithErrorsCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.rootErrorStats.children["user"].errorsCount).toBe(1);
  });
})
