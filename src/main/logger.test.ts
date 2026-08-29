import { Logger } from './logger';
import { LogEntry } from '../shared/types';

describe('Logger', () => {
  let entries: LogEntry[];
  let logger: Logger;

  beforeEach(() => {
    entries = [];
    logger = new Logger((entry) => entries.push(entry));
  });

  it('forwards info messages to the sink', () => {
    logger.info('hello');
    expect(entries).toEqual([expect.objectContaining({ level: 'info', message: 'hello' })]);
  });

  it('forwards debug messages to the sink in a production build', () => {
    // debug() used to be gated on NODE_ENV === 'development', so every debug
    // call was a no-op in the packaged app and the logLevel setting's "debug"
    // option did nothing. Filtering by level belongs to the sink, not here.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      logger.debug('poll returned 403');
    } finally {
      process.env.NODE_ENV = previous;
    }

    expect(entries).toEqual([
      expect.objectContaining({ level: 'debug', message: 'poll returned 403' }),
    ]);
  });

  it('applies its prefix to debug messages', () => {
    const child = logger.child('BrokerProxy');
    child.debug('polling');
    expect(entries[0].message).toContain('BrokerProxy');
  });
});
