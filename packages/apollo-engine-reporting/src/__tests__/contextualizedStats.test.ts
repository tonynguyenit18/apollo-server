import { Trace } from 'apollo-engine-reporting-protobuf';
import { dateToProtoTimestamp } from '../treeBuilder';
import { ContextualizedStats } from '../contextualizedStats';
import { DurationHistogram } from '../durationHistogram';

describe('Check query latency stats when', () => {
  const statsContext = {
    clientReferenceId: 'reference',
    clientVersion: 'version',
  };

  const baseDate = new Date();
  const duration = 30 * 1000;
  const nonFederatedTrace = new Trace({
    startTime: dateToProtoTimestamp(baseDate),
    endTime: dateToProtoTimestamp(new Date(baseDate.getTime() + duration)),
    durationNs: duration,
    root: null,
    signature: 'signature',
    details: null,
  });

  it('adding a single trace', () => {
    const contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(nonFederatedTrace);
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.latencyCount).toStrictEqual(
      new DurationHistogram().incrementDuration(duration),
    );
    expect(contextualizedStats.queryLatencyStats.requestsWithErrorsCount).toBe(
      0,
    );
  });
  it('adding a fully cached trace', () => {
    const contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(
      new Trace({
        ...nonFederatedTrace,
        fullQueryCacheHit: true,
      }),
    );
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.cacheHits).toBe(1);
    expect(
      contextualizedStats.queryLatencyStats.cacheLatencyCount,
    ).toStrictEqual(new DurationHistogram().incrementDuration(duration));
  });
  it('adding a public cached trace', () => {
    const contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(
      new Trace({
        ...nonFederatedTrace,
        fullQueryCacheHit: false,
        cachePolicy: {
          scope: Trace.CachePolicy.Scope.PRIVATE,
          maxAgeNs: 1000,
        },
      }),
    );
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(
      contextualizedStats.queryLatencyStats.privateCacheTtlCount,
    ).toStrictEqual(new DurationHistogram().incrementDuration(1000));
  });
  it('adding a private cached trace', () => {
    const contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(
      new Trace({
        ...nonFederatedTrace,
        fullQueryCacheHit: false,
        cachePolicy: {
          scope: Trace.CachePolicy.Scope.PUBLIC,
          maxAgeNs: 1000,
        },
      }),
    );
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(
      contextualizedStats.queryLatencyStats.publicCacheTtlCount,
    ).toStrictEqual(new DurationHistogram().incrementDuration(1000));
  });
  it('adding a persisted hit trace', () => {
    const contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(
      new Trace({
        ...nonFederatedTrace,
        persistedQueryHit: true,
      }),
    );
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.persistedQueryHits).toBe(1);
  });
  it('adding a persisted miss trace', () => {
    const contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(
      new Trace({
        ...nonFederatedTrace,
        persistedQueryRegister: true,
      }),
    );
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.persistedQueryMisses).toBe(1);
  });
  it('adding a forbidden trace', () => {
    const contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(
      new Trace({
        ...nonFederatedTrace,
        forbiddenOperation: true,
      }),
    );
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.forbiddenOperationCount).toBe(
      1,
    );
  });
  it('adding a registered trace', () => {
    const contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(
      new Trace({
        ...nonFederatedTrace,
        registeredOperation: true,
      }),
    );
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(contextualizedStats.queryLatencyStats.registeredOperationCount).toBe(
      1,
    );
  });
  it('adding an errored trace ', () => {
    const contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(
      new Trace({
        ...nonFederatedTrace,
        registeredOperation: true,
        root: {
          child: [
            {
              responseName: 'user',
              parentType: 'Query',
              type: 'User!',
              error: [
                {
                  message: 'error 1',
                },
              ],
            },
          ],
        },
      }),
    );
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(1);
    expect(
      contextualizedStats.queryLatencyStats.rootErrorStats.children['user']
        .requestsWithErrorsCount,
    ).toBe(1);
    expect(
      contextualizedStats.queryLatencyStats.rootErrorStats.children['user']
        .errorsCount,
    ).toBe(1);
  });
  it('merging errored traces', () => {
    const contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(
      new Trace({
        ...nonFederatedTrace,
        registeredOperation: true,
        root: {
          child: [
            {
              responseName: 'user',
              parentType: 'Query',
              type: 'User!',
              error: [
                {
                  message: 'error 1',
                },
              ],
            },
          ],
        },
      }),
    );
    contextualizedStats.addTrace(
      new Trace({
        ...nonFederatedTrace,
        registeredOperation: true,
        root: {
          child: [
            {
              responseName: 'account',
              parentType: 'Query',
              type: 'Account!',
              child: [
                {
                  responseName: 'name',
                  parentType: 'Account',
                  type: 'String!',
                  error: [
                    {
                      message: 'has error',
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    for (let _ in [1, 2]) {
      contextualizedStats.addTrace(
        new Trace({
          ...nonFederatedTrace,
          registeredOperation: true,
          root: {
            child: [
              {
                responseName: 'user',
                parentType: 'Query',
                type: 'User!',
                child: [
                  {
                    responseName: 'email',
                    parentType: 'User',
                    type: 'String!',
                    error: [
                      {
                        message: 'has error',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      );
    }

    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(4);
    expect(
      contextualizedStats.queryLatencyStats.rootErrorStats.children['user']
        .requestsWithErrorsCount,
    ).toBe(1);
    expect(
      contextualizedStats.queryLatencyStats.rootErrorStats.children['user']
        .errorsCount,
    ).toBe(1);
    expect(
      contextualizedStats.queryLatencyStats.rootErrorStats.children['user']
        .children['email'].requestsWithErrorsCount,
    ).toBe(2);
    expect(
      contextualizedStats.queryLatencyStats.rootErrorStats.children['user']
        .children['email'].errorsCount,
    ).toBe(2);
    expect(
      contextualizedStats.queryLatencyStats.rootErrorStats.children['account']
        .requestsWithErrorsCount,
    ).toBeFalsy();
    expect(
      contextualizedStats.queryLatencyStats.rootErrorStats.children['account']
        .errorsCount,
    ).toBeFalsy();
    expect(
      contextualizedStats.queryLatencyStats.rootErrorStats.children['account']
        .children['name'].requestsWithErrorsCount,
    ).toBe(1);
    expect(
      contextualizedStats.queryLatencyStats.rootErrorStats.children['account']
        .children['name'].errorsCount,
    ).toBe(1);
  });
  it('merging non-errored traces', () => {
    const contextualizedStats = new ContextualizedStats(statsContext);
    contextualizedStats.addTrace(nonFederatedTrace);
    contextualizedStats.addTrace(nonFederatedTrace);
    contextualizedStats.addTrace(
      new Trace({
        ...nonFederatedTrace,
        fullQueryCacheHit: false,
        cachePolicy: {
          scope: Trace.CachePolicy.Scope.PRIVATE,
          maxAgeNs: 1000,
        },
      }),
    );
    contextualizedStats.addTrace(
      new Trace({
        ...nonFederatedTrace,
        fullQueryCacheHit: false,
        cachePolicy: {
          scope: Trace.CachePolicy.Scope.PRIVATE,
          maxAgeNs: 1000,
        },
      }),
    );
    for (let _ in [1, 2]) {
      contextualizedStats.addTrace(
        new Trace({
          ...nonFederatedTrace,
          fullQueryCacheHit: true,
        }),
      );
    }
    expect(contextualizedStats.queryLatencyStats.requestCount).toBe(6);
    expect(contextualizedStats.queryLatencyStats.latencyCount).toStrictEqual(
      new DurationHistogram()
        .incrementDuration(duration)
        .incrementDuration(duration)
        .incrementDuration(duration)
        .incrementDuration(duration),
    );
    expect(contextualizedStats.queryLatencyStats.requestsWithErrorsCount).toBe(
      0,
    );
    expect(
      contextualizedStats.queryLatencyStats.privateCacheTtlCount,
    ).toStrictEqual(
      new DurationHistogram().incrementDuration(1000).incrementDuration(1000),
    );
    expect(contextualizedStats.queryLatencyStats.cacheHits).toBe(2);
    expect(
      contextualizedStats.queryLatencyStats.cacheLatencyCount,
    ).toStrictEqual(
      new DurationHistogram()
        .incrementDuration(duration)
        .incrementDuration(duration),
    );
  });
});
