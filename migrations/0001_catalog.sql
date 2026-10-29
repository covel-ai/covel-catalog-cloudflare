-- All multi-statement state transitions use D1 transactional batch().
CREATE TABLE assertions (id INTEGER PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings VALUES ('maintenance','0');
CREATE TABLE snapshots (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('staging','published')),
 base_id TEXT, created INTEGER NOT NULL, generated TEXT NOT NULL, data TEXT NOT NULL,
 expected_count INTEGER NOT NULL, expected_chain TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 0,
 chain TEXT NOT NULL, entries INTEGER NOT NULL DEFAULT 0, releases INTEGER NOT NULL DEFAULT 0, issues INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX snapshots_kind ON snapshots(kind,created DESC);
CREATE TABLE current_snapshots (kind TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES snapshots(id));
CREATE TABLE ingest_locks (kind TEXT PRIMARY KEY, holder TEXT NOT NULL, until_ms INTEGER NOT NULL);
CREATE TABLE snapshot_entries (
 snapshot_id TEXT NOT NULL, key TEXT NOT NULL, generation INTEGER NOT NULL, end_generation INTEGER NOT NULL DEFAULT 9007199254740991, revision_id TEXT, data TEXT NOT NULL, summary TEXT NOT NULL,
 kind TEXT NOT NULL, repository_id INTEGER, owner_id INTEGER, path TEXT, commit_sha TEXT, content_hash TEXT,
 name TEXT NOT NULL, package_id TEXT NOT NULL, names TEXT NOT NULL, searchable TEXT NOT NULL,
 status TEXT NOT NULL, official INTEGER NOT NULL, category TEXT NOT NULL, locales TEXT NOT NULL,
 updated TEXT NOT NULL, stars INTEGER NOT NULL, downloads INTEGER NOT NULL,
 PRIMARY KEY(snapshot_id,key)
);
CREATE INDEX entries_key ON snapshot_entries(key,snapshot_id);
CREATE INDEX entries_updated ON snapshot_entries(kind,updated DESC,key,generation,end_generation);
CREATE INDEX entries_name ON snapshot_entries(kind,name,key,generation,end_generation);
CREATE INDEX entries_stars ON snapshot_entries(kind,stars DESC,key,generation,end_generation);
CREATE INDEX entries_downloads ON snapshot_entries(kind,downloads DESC,key,generation,end_generation);
CREATE INDEX entries_filters ON snapshot_entries(kind,category,status,official,generation,end_generation);
CREATE VIRTUAL TABLE search_index USING fts5(grams, tokenize='ascii');
CREATE TABLE issues (snapshot_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(snapshot_id,seq));
CREATE TABLE revision_candidates (snapshot_id TEXT NOT NULL,id TEXT NOT NULL,entry_key TEXT NOT NULL,version TEXT,channel TEXT NOT NULL,source_hash TEXT NOT NULL,conflict INTEGER NOT NULL,created INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(snapshot_id,id));
CREATE INDEX candidate_version ON revision_candidates(snapshot_id,entry_key,version,channel);
CREATE TABLE observation_candidates (snapshot_id TEXT NOT NULL,id TEXT NOT NULL,revision_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(snapshot_id,id));
CREATE TABLE binding_candidates (snapshot_id TEXT NOT NULL,entry_key TEXT NOT NULL,tag TEXT NOT NULL,commit_sha TEXT NOT NULL,PRIMARY KEY(snapshot_id,entry_key,tag));
CREATE TABLE revisions (id TEXT PRIMARY KEY,entry_key TEXT NOT NULL,version TEXT,channel TEXT NOT NULL,source_hash TEXT NOT NULL,conflict INTEGER NOT NULL,created INTEGER NOT NULL,data TEXT NOT NULL);
CREATE INDEX revisions_entry ON revisions(entry_key,created DESC,id);
CREATE INDEX revisions_version ON revisions(entry_key,version,channel,source_hash);
CREATE TABLE observations (id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX observations_revision ON observations(revision_id);
CREATE TABLE tag_bindings (entry_key TEXT NOT NULL,tag TEXT NOT NULL,commit_sha TEXT NOT NULL,PRIMARY KEY(entry_key,tag));
CREATE TABLE artifacts (revision_id TEXT NOT NULL,packager_version TEXT NOT NULL,sha256 TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(revision_id,packager_version));
CREATE INDEX artifacts_revision ON artifacts(revision_id,created DESC);
CREATE TABLE policies (sequence INTEGER PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE policy_rules (sequence INTEGER NOT NULL,id TEXT NOT NULL,kind TEXT,repository_id INTEGER,owner_id INTEGER,path TEXT,commit_sha TEXT,content_hash TEXT,artifact_sha TEXT,reason TEXT NOT NULL,PRIMARY KEY(sequence,id));
CREATE INDEX policy_repo ON policy_rules(sequence,repository_id);
CREATE INDEX policy_owner ON policy_rules(sequence,owner_id);
CREATE INDEX policy_content ON policy_rules(sequence,content_hash);
CREATE INDEX policy_artifact ON policy_rules(sequence,artifact_sha);
CREATE TABLE counters (entry_key TEXT PRIMARY KEY,requests INTEGER NOT NULL);
CREATE TABLE tickets (token TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,entry_key TEXT NOT NULL,revision_id TEXT NOT NULL,packager_version TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TRIGGER ticket_count AFTER INSERT ON tickets BEGIN
 INSERT INTO counters VALUES(new.entry_key,1) ON CONFLICT(entry_key) DO UPDATE SET requests=requests+1;
END;
CREATE TABLE download_requests (request_key TEXT PRIMARY KEY,entry_key TEXT NOT NULL,revision_id TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE jobs (id TEXT PRIMARY KEY,type TEXT NOT NULL,kind TEXT NOT NULL,revision_id TEXT,payload TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available INTEGER NOT NULL,lease_hash TEXT,lease_until INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,finished INTEGER,error TEXT);
CREATE INDEX jobs_queue ON jobs(state,available,created);
CREATE TABLE github_gate (id INTEGER PRIMARY KEY CHECK(id=1),lease_hash TEXT,lease_until INTEGER NOT NULL DEFAULT 0,window INTEGER NOT NULL DEFAULT 0,used INTEGER NOT NULL DEFAULT 0,cooldown INTEGER NOT NULL DEFAULT 0);
INSERT INTO github_gate(id) VALUES(1);
CREATE TABLE dispatch_gate (id INTEGER PRIMARY KEY CHECK(id=1),next_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO dispatch_gate(id) VALUES(1);
CREATE TABLE object_reservations (key TEXT PRIMARY KEY,bytes INTEGER NOT NULL,created INTEGER NOT NULL);
CREATE TABLE checkpoints (name TEXT PRIMARY KEY,object_key TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE prepared_artifacts (cache_key TEXT PRIMARY KEY,data TEXT NOT NULL,identity TEXT NOT NULL);
CREATE UNIQUE INDEX one_collection_per_kind ON jobs(kind) WHERE type='collect' AND state IN ('queued','running');

CREATE INDEX entries_active ON snapshot_entries(kind,end_generation,key);
CREATE TABLE staged_membership(snapshot_id TEXT NOT NULL,key TEXT NOT NULL,repository_id INTEGER NOT NULL,package INTEGER NOT NULL,status TEXT NOT NULL,PRIMARY KEY(snapshot_id,key));
INSERT INTO settings VALUES ('artifact_epoch','0');
CREATE TABLE query_totals (key TEXT PRIMARY KEY,data TEXT NOT NULL,created INTEGER NOT NULL);
