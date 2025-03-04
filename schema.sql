CREATE TABLE embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transcript_id INTEGER NOT NULL,
      embedding TEXT NOT NULL,
      FOREIGN KEY(transcript_id) REFERENCES transcripts(id)
    );
CREATE TABLE transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_title TEXT NOT NULL,
      segment_text TEXT NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL
    );