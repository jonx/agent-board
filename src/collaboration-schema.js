// Additive schema: public durable attention, task dependencies and versioned skills.
export function migrateCollaboration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_reads (
      agent_id INTEGER NOT NULL REFERENCES agents(id), thread_id INTEGER NOT NULL REFERENCES threads(id),
      last_read_message_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS message_reads (
      agent_id INTEGER NOT NULL REFERENCES agents(id), message_id INTEGER NOT NULL REFERENCES messages(id),
      PRIMARY KEY(agent_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL,
      thread_id INTEGER REFERENCES threads(id), task_id INTEGER REFERENCES tasks(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      notification_id INTEGER NOT NULL REFERENCES notifications(id), agent_id INTEGER NOT NULL REFERENCES agents(id),
      received_at TEXT, lease_until TEXT, lease_token TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      retry_at TEXT, last_error TEXT, PRIMARY KEY(notification_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS task_details (
      task_id INTEGER PRIMARY KEY REFERENCES tasks(id), requester_id INTEGER REFERENCES agents(id),
      state TEXT NOT NULL DEFAULT 'offered', criteria TEXT NOT NULL DEFAULT '', result TEXT,
      ref TEXT, deadline TEXT, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id INTEGER NOT NULL REFERENCES tasks(id), depends_on INTEGER NOT NULL REFERENCES tasks(id),
      PRIMARY KEY(task_id, depends_on), CHECK(task_id <> depends_on)
    );
    CREATE TABLE IF NOT EXISTS skill_versions (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      version INTEGER NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL, reason TEXT NOT NULL,
      author_id INTEGER NOT NULL REFERENCES agents(id), thread_id INTEGER NOT NULL REFERENCES threads(id),
      created_at TEXT NOT NULL, UNIQUE(project_id, name, version)
    );
    CREATE TABLE IF NOT EXISTS skill_feedback (
      id INTEGER PRIMARY KEY, skill_version_id INTEGER NOT NULL REFERENCES skill_versions(id),
      author_id INTEGER NOT NULL REFERENCES agents(id), task_id INTEGER REFERENCES tasks(id),
      outcome TEXT NOT NULL CHECK(outcome IN ('helped','failed','neutral')), evidence TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS delivery_agent ON deliveries(agent_id, received_at);
  `);
  for (const table of ['notifications', 'skill_versions', 'skill_feedback']) {
    for (const action of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS inv_${table}_${action.toLowerCase()}
      BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, '${table} are append-only'); END;`);
  }
  if(!db.prepare('PRAGMA table_info(reactions)').all().some(c=>c.name==='message_id')) db.exec('ALTER TABLE reactions ADD COLUMN message_id INTEGER REFERENCES messages(id)');
  // Preserve existing read knowledge once. Future thread reads never advance a project cursor.
  db.exec(`INSERT OR IGNORE INTO agent_reads(agent_id, thread_id, last_read_message_id)
    SELECT m.agent_id, t.id, m.last_read_message_id FROM memberships m JOIN threads t ON t.project_id=m.project_id
    WHERE m.last_read_message_id > 0;`);
}
