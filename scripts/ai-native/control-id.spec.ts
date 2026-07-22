import { describe, expect, it } from 'bun:test';
import {
  controlId,
  historicalAliasesFor,
  resolveAlias,
  validateAliasMap,
} from './control-id';
import { fixtureControlIds } from './scanner';
import type { AliasMap } from './types';

function onlyId(source: string, file = 'src/SavePanel.tsx'): string {
  const rows = fixtureControlIds(source, { file });
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

describe('control_id invariants', () => {
  it('does not change when only the handler implementation changes', () => {
    const before = onlyId(`
      export function SavePanel() {
        return <button data-testid="save" className="primary" onClick={() => setDraft(true)}>Save</button>;
      }
    `);
    const after = onlyId(`
      export function SavePanel() {
        return <button data-testid="save" className="primary" onClick={() => dispatchAction('document.save')}>Save</button>;
      }
    `);
    expect(after).toBe(before);
  });

  it('does not change when lines move or formatting changes', () => {
    const compact = onlyId(`export function SavePanel(){return <button aria-label="save" onClick={save}>Save</button>}`);
    const formatted = onlyId(`

      // unrelated lines above the component
      export function SavePanel() {
        return (
          <button
            aria-label="save"
            onClick={save}
          >
            Save
          </button>
        );
      }
    `);
    expect(formatted).toBe(compact);
  });

  it('includes static value attributes but ignores dynamic value expressions', () => {
    const scene = onlyId(`export function Mode(){return <button value="scene" onClick={select}>Mode</button>}`);
    const ai = onlyId(`export function Mode(){return <button value="ai" onClick={select}>Mode</button>}`);
    expect(ai).not.toBe(scene);

    const selected = onlyId(`export function Mode(){return <button value={selected} onClick={select}>Mode</button>}`);
    const current = onlyId(`export function Mode(){return <button value={current} onClick={select}>Mode</button>}`);
    expect(current).toBe(selected);
  });

  it('uses an ordinal only to distinguish identical siblings', () => {
    const source = `
      export function Toolbar() {
        return <><button onClick={first}>Run</button><button onClick={second}>Run</button></>;
      }
    `;
    const ids = fixtureControlIds(source).map((row) => row.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('changes for file moves or component renames and records migration through alias-map', () => {
    const oldId = onlyId(`export function SavePanel(){return <button onClick={save}>Save</button>}`);
    const movedId = onlyId(
      `export function SavePanel(){return <button onClick={save}>Save</button>}`,
      'src/panels/SavePanel.tsx',
    );
    const renamedId = onlyId(`export function PersistPanel(){return <button onClick={save}>Save</button>}`);
    expect(movedId).not.toBe(oldId);
    expect(renamedId).not.toBe(oldId);

    const aliases: AliasMap = {
      version: 1,
      aliases: [
        { old_control_id: oldId, new_control_id: movedId, reason: 'component moved to panels/' },
      ],
    };
    expect(validateAliasMap(aliases)).toEqual([]);
    expect(resolveAlias(oldId, aliases)).toBe(movedId);
    expect(historicalAliasesFor(movedId, aliases)).toEqual([oldId]);
  });

  it('rejects malformed, duplicate, and no-op aliases', () => {
    const id = controlId({
      repo: 'interface',
      relativePath: 'src/A.tsx',
      component: 'A',
      event: 'onClick',
      elementType: 'button',
    });
    const issues = validateAliasMap({
      version: 1,
      aliases: [
        { old_control_id: id, new_control_id: id, reason: '' },
        { old_control_id: id, new_control_id: 'bad', reason: 'duplicate' },
      ],
    });
    expect(issues.some((issue) => issue.includes('no-op'))).toBe(true);
    expect(issues.some((issue) => issue.includes('missing reason'))).toBe(true);
    expect(issues.some((issue) => issue.includes('duplicate old_control_id'))).toBe(true);
    expect(issues.some((issue) => issue.includes('invalid new_control_id'))).toBe(true);
  });

  it('rejects alias cycles', () => {
    const a = controlId({ repo: 'interface', relativePath: 'src/A.tsx', component: 'A', event: 'onClick', elementType: 'button' });
    const b = controlId({ repo: 'interface', relativePath: 'src/B.tsx', component: 'B', event: 'onClick', elementType: 'button' });
    const issues = validateAliasMap({
      version: 1,
      aliases: [
        { old_control_id: a, new_control_id: b, reason: 'move A to B' },
        { old_control_id: b, new_control_id: a, reason: 'invalid reverse move' },
      ],
    });
    expect(issues.some((issue) => issue.includes('alias cycle'))).toBe(true);
  });
});
