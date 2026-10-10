CREATE SEQUENCE urls_id_seq START 100000000000 INCREMENT 1000;

CREATE TABLE urls (
  id         BIGINT PRIMARY KEY,
  short_code VARCHAR(16) UNIQUE NOT NULL,
  long_url   TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE TABLE clicks (
  id         BIGSERIAL PRIMARY KEY,
  short_code VARCHAR(16) NOT NULL,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  referrer   TEXT,
  user_agent TEXT
);
CREATE INDEX clicks_code_time_idx ON clicks (short_code, clicked_at);