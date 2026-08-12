import { expect, test } from 'bun:test';

import { hasConnectedEditorTransportScope } from './editor-facts-publisher';

test('does not treat a missing editor carrier as transport-ready', () => {
  expect(hasConnectedEditorTransportScope({ ok: true, connected: false, scopes: [] }, 'game:sample')).toBe(false);
  expect(hasConnectedEditorTransportScope({ ok: true, connected: true, scopes: ['game:other'] }, 'game:sample')).toBe(false);
});

test('recognizes the active connected editor carrier scope', () => {
  expect(hasConnectedEditorTransportScope({ ok: true, connected: true, scopes: ['game:sample'] }, 'game:sample')).toBe(true);
});
