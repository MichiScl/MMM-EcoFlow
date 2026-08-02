const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMaxHistoryEntries, trimHistoryToLimit } = require('../lib/history');

test('normalizes max history entries and trims oldest records', () => {
    assert.equal(normalizeMaxHistoryEntries('10000'), 10000);
    assert.equal(normalizeMaxHistoryEntries(undefined), Infinity);
    assert.equal(normalizeMaxHistoryEntries('invalid'), Infinity);

    const history = [{ id: 1 }, { id: 2 }, { id: 3 }];
    assert.deepEqual(trimHistoryToLimit(history, 2), [{ id: 2 }, { id: 3 }]);
});
