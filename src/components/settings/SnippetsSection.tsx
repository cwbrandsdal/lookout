import { CornerDownLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import type { Snippet } from '../../shared/settings';
import { getState, pushToast, useApp } from '../../state/store';
import { Field, Group, Switch, TextField } from './controls';
import { cx } from './filter';
import { slugify, uniqueId } from './helpers';
import { updateSettings } from './save';

function patchSnippet(id: string, mutate: (snippet: Snippet) => void): Promise<boolean> {
  return updateSettings((draft) => {
    const snippet = draft.snippets.find((entry) => entry.id === id);
    if (!snippet) return false;
    mutate(snippet);
  });
}

function removeSnippet(snippet: Snippet): void {
  const index = getState().settings.snippets.findIndex((entry) => entry.id === snippet.id);
  void updateSettings((draft) => {
    draft.snippets = draft.snippets.filter((entry) => entry.id !== snippet.id);
  }).then((saved) => {
    if (!saved) return;
    pushToast({
      tone: 'info',
      title: `Deleted “${snippet.name}”`,
      action: {
        label: 'Undo',
        run: () =>
          void updateSettings((draft) => {
            if (draft.snippets.some((entry) => entry.id === snippet.id)) return false;
            draft.snippets.splice(Math.max(0, Math.min(index, draft.snippets.length)), 0, snippet);
          }),
      },
    });
  });
}

const required = (what: string) => (value: string) => (value.trim() ? null : `${what} is required.`);

export function SnippetsSection() {
  const snippets = useApp((state) => state.settings.snippets);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <Group
      section="snippets"
      description="Saved commands. Run them from the command palette (Ctrl+Shift+P, then type the name) or give them a shortcut under Keyboard."
      actions={
        !creating ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setEditing(null);
              setCreating(true);
            }}
          >
            <Plus size={13} />
            New snippet
          </button>
        ) : null
      }
      bare
    >
      {creating ? <NewSnippet onDone={() => setCreating(false)} /> : null}
      {snippets.length ? (
        <ul className="settings-panel settings-list" aria-label="Snippets">
          {snippets.map((snippet) => {
            const isEditing = editing === snippet.id;
            return (
              <li key={snippet.id} className={cx('settings-item settings-item--snippet', isEditing && 'is-selected')}>
                <div className="settings-item__row">
                  <button
                    type="button"
                    className="settings-item__main"
                    aria-expanded={isEditing}
                    onClick={() => setEditing(isEditing ? null : snippet.id)}
                  >
                    <span className="settings-item__title truncate">{snippet.name}</span>
                    <code className="settings-item__code truncate">{snippet.command.split(/\r?\n/)[0]}</code>
                    {snippet.run ? (
                      <span className="chip settings-item__chip" title="Presses Enter after inserting">
                        <CornerDownLeft size={10} />
                        runs
                      </span>
                    ) : null}
                  </button>
                  <span className="settings-item__actions">
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm"
                      aria-label={`Edit ${snippet.name}`}
                      title="Edit"
                      onClick={() => setEditing(isEditing ? null : snippet.id)}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm icon-btn--danger"
                      aria-label={`Delete ${snippet.name}`}
                      title="Delete"
                      onClick={() => removeSnippet(snippet)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                </div>
                {isEditing ? <SnippetEditor key={snippet.id} snippet={snippet} /> : null}
              </li>
            );
          })}
        </ul>
      ) : !creating ? (
        <div className="settings-panel settings-empty">No snippets yet.</div>
      ) : null}
    </Group>
  );
}

function SnippetEditor({ snippet }: { snippet: Snippet }) {
  return (
    <div className="settings-item__editor">
      <Field label="Name">
        {(id) => (
          <TextField id={id} width={260} value={snippet.name} validate={required('A name')} onCommit={(value) => patchSnippet(snippet.id, (entry) => { entry.name = value.trim(); })} />
        )}
      </Field>
      <Field stacked label="Command" description="Inserted as typed. Several lines are sent as several lines.">
        {(id) => (
          <TextField
            id={id}
            multiline
            rows={3}
            width="100%"
            value={snippet.command}
            validate={required('A command')}
            onCommit={(value) => patchSnippet(snippet.id, (entry) => { entry.command = value; })}
          />
        )}
      </Field>
      <Field label="Press Enter after inserting">
        {(id) => <Switch id={id} checked={snippet.run} onChange={(value) => void patchSnippet(snippet.id, (entry) => { entry.run = value; })} />}
      </Field>
    </div>
  );
}

function NewSnippet({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [run, setRun] = useState(false);
  const valid = Boolean(name.trim() && command.trim());

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const snippet: Snippet = {
      id: uniqueId(slugify(name) || 'snippet', getState().settings.snippets.map((entry) => entry.id)),
      name: name.trim(),
      command,
      run,
    };
    void updateSettings((draft) => { draft.snippets.push(snippet); }).then((saved) => saved && onDone());
  };

  return (
    <form
      className="settings-panel settings-new"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDone();
        }
      }}
    >
      <Field label="Name">
        {(id) => <input id={id} className="input" style={{ width: 260 }} autoFocus autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} />}
      </Field>
      <Field stacked label="Command">
        {(id) => (
          <textarea
            id={id}
            className="textarea"
            rows={3}
            spellCheck={false}
            value={command}
            placeholder="git fetch --all --prune"
            onChange={(event) => setCommand(event.target.value)}
          />
        )}
      </Field>
      <Field label="Press Enter after inserting">{(id) => <Switch id={id} checked={run} onChange={setRun} />}</Field>
      <div className="settings-new__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary btn--sm" disabled={!valid}>
          Add snippet
        </button>
      </div>
    </form>
  );
}
