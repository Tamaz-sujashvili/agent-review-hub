import { useState } from 'react';
import type { TaskState, TaskView } from '@quorum/protocol';
import { call, timeAgo, useLive } from '../bridge';
import { Empty, ErrorNote, StateBadge, WaitReasonNote } from '../components/common';

const COLUMNS: { title: string; states: TaskState[] }[] = [
  { title: 'Queued', states: ['QUEUED'] },
  { title: 'Authoring', states: ['AUTHORING', 'SYNCING'] },
  { title: 'In review', states: ['AWAITING_REVIEWER', 'IN_REVIEW'] },
  { title: 'Merging', states: ['MERGE_QUEUED', 'MERGING'] },
  { title: 'Needs attention', states: ['ESCALATED', 'PAUSED'] },
  { title: 'Done', states: ['MERGED', 'CANCELLED', 'FAILED'] },
];

export function Tasks({ onOpen }: { onOpen: (id: number) => void }) {
  const [mine, setMine] = useState(true);
  const tasks = useLive(() => call('listTasks', { query: { mine: mine ? 'true' : 'false' } }), [mine], { events: ['task.updated'] });

  return (
    <div className="stack">
      <div className="row">
        <h2 className="grow">Tasks</h2>
        <label className="row inline">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine
        </label>
      </div>
      <ErrorNote error={tasks.error} />
      {tasks.data === undefined ? (
        <Empty>Loading…</Empty>
      ) : (
        <div className="board">
          {COLUMNS.map((col) => {
            const items = tasks.data!.tasks.filter((t) => col.states.includes(t.state));
            return (
              <div className="column" key={col.title}>
                <h4>
                  {col.title} <span className="muted">{items.length}</span>
                </h4>
                {items.length === 0 && <div className="muted small">—</div>}
                {items.slice(0, col.title === 'Done' ? 30 : 100).map((t) => (
                  <TaskCard key={t.id} task={t} onOpen={onOpen} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, onOpen }: { task: TaskView; onOpen: (id: number) => void }) {
  return (
    <button className="task-card" onClick={() => onOpen(task.id)}>
      <div className="row">
        <span className="muted">#{task.id}</span>
        <span className="grow" />
        <StateBadge state={task.state} />
      </div>
      <div className="task-title">{task.title}</div>
      <div className="muted small">
        {task.requesterOwner} · round {task.reviewRound} · {timeAgo(task.updatedAt)}
      </div>
      <WaitReasonNote reason={task.waitReason} compact />
      {task.escalationReason !== null && <div className="small danger-text">{task.escalationReason}</div>}
    </button>
  );
}
