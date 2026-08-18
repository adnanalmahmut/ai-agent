import { describe, expect, it } from '@jest/globals';

import { QueuePublishError, classifyPublishError } from './queue-publish.error';

/**
 * The classification that decides whether durably accepted work survives an
 * outage.
 *
 * The two mistakes are not equally expensive, and the tests are written around
 * that asymmetry. Calling a poison event transient costs one retry per backoff
 * interval and leaves a row visibly stuck. Calling a transport outage permanent
 * destroys work the API has already told a caller it accepted — and does it
 * precisely when the system is under stress and nobody is reading logs closely.
 */
describe('classifyPublishError', () => {
  /**
   * Every one of these is something a real Redis or ioredis emits during an
   * outage. None of them is enumerated in the implementation — they are all
   * covered by "unknown means transient" — which is the point: this list can
   * grow when a driver rewords a message and the classification still holds.
   */
  describe('transport failures are transient', () => {
    const transportErrors = [
      'connect ECONNREFUSED 127.0.0.1:6379',
      'read ECONNRESET',
      'connect ETIMEDOUT',
      'write EPIPE',
      'getaddrinfo ENOTFOUND redis',
      'Connection is closed.',
      "Stream isn't writeable and enableOfflineQueue options is false",
      'Reached the max retries per request limit (which is 2).',
      'Command timed out',
      "OOM command not allowed when used memory > 'maxmemory'.",
      'LOADING Redis is loading the dataset in memory',
      'CLUSTERDOWN Hash slot not served',
      "READONLY You can't write against a read only replica.",
    ];

    it.each(transportErrors)('%s', (message) => {
      expect(classifyPublishError(new Error(message))).toBe('transient');
    });
  });

  /**
   * Only failures whose outcome is a property of the *event* rather than of the
   * transport. The thousandth attempt fails exactly like the first.
   */
  describe('deterministic failures are permanent', () => {
    const permanentErrors = [
      'Converting circular structure to JSON',
      'Do not know how to serialize a BigInt',
      'The size of job execute exceeds the limit 1024 bytes',
    ];

    it.each(permanentErrors)('%s', (message) => {
      expect(classifyPublishError(new Error(message))).toBe('permanent');
    });
  });

  /**
   * The default, and the safety property. An unrecognised error could be
   * anything; treating it as transient means the worst case is a retry, whereas
   * treating it as permanent means the worst case is lost work.
   */
  describe('the unknown is transient', () => {
    it.each([
      'EPROTO something nobody has seen before',
      'Unexpected server response: 500',
      '',
    ])('%s', (message) => {
      expect(classifyPublishError(new Error(message))).toBe('transient');
    });

    it('classifies a non-Error rejection as transient', () => {
      expect(classifyPublishError('just a string')).toBe('transient');
      expect(classifyPublishError(undefined)).toBe('transient');
      expect(classifyPublishError({ code: 'ECONNRESET' })).toBe('transient');
    });
  });
});

describe('QueuePublishError', () => {
  /**
   * A timeout is a statement about the transport, never about the event: it says
   * the queue did not answer in time. Classifying it from a message would be
   * fragile for no gain.
   */
  it('is always transient when the publish timed out', () => {
    const error = new QueuePublishError(
      'agent-execution',
      'timeout',
      'Publishing to "agent-execution" exceeded 2000ms',
    );

    expect(error.kind).toBe('transient');
  });

  it('classifies a rejection from its cause', () => {
    const cause = new Error('Converting circular structure to JSON');
    const error = new QueuePublishError(
      'agent-execution',
      'rejected',
      cause.message,
      cause,
    );

    expect(error.kind).toBe('permanent');
  });

  it('falls back to its own message when there is no cause', () => {
    expect(
      new QueuePublishError(
        'agent-execution',
        'rejected',
        'connect ECONNREFUSED',
      ).kind,
    ).toBe('transient');
  });

  it('keeps the queue name and reason for the caller', () => {
    const error = new QueuePublishError('agent-execution', 'timeout', 'slow');

    expect(error.queue).toBe('agent-execution');
    expect(error.reason).toBe('timeout');
    expect(error.name).toBe('QueuePublishError');
    expect(error).toBeInstanceOf(Error);
  });
});
