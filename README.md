# mcp-embedding-search

A Model Context Protocol (MCP) server that queries a Turso database containing
embeddings and transcript segments. This tool allows users to search for relevant 
transcript segments by asking questions, without generating new embeddings.

<a href="https://glama.ai/mcp/servers/mcp-embedding-search">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/mcp-embedding-search/badge" />
</a>

## Features

- 🔍 Vector similarity search for transcript segments
- 📊 Relevance scoring based on cosine similarity
- 📝 Complete transcript metadata (episode title, timestamps)
- ⚙️ Configurable search parameters (limit, minimum score)
- 🔄 Efficient database connection pooling
- 🛡️ Comprehensive error handling
- 📈 Performance optimized for quick responses

## Configuration

This server requires configuration through your MCP client. Here are
examples for different environments:

### Cline Configuration

Add this to your Cline MCP settings:

```json
{
  "mcpServers": {
    "mcp-embedding-search": {
      "command": "node",
      "args": ["/path/to/mcp-embedding-search/dist/index.js"],
      "env": {
        "TURSO_URL": "your-turso-database-url",
        "TURSO_AUTH_TOKEN": "your-turso-auth-token"
      }
    }
  }
}
```

### Claude Desktop Configuration

Add this to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "mcp-embedding-search": {
      "command": "node",
      "args": ["/path/to/mcp-embedding-search/dist/index.js"],
      "env": {
        "TURSO_URL": "your-turso-database-url",
        "TURSO_AUTH_TOKEN": "your-turso-auth-token"
      }
    }
  }
}
```

## API

The server implements one MCP tool:

### search_embeddings

Search for relevant transcript segments using vector similarity.

Parameters:

- `question` (string, required): The query text to search for
- `limit` (number, optional): Number of results to return (default: 5, max: 50)
- `min_score` (number, optional): Minimum similarity threshold (default: 0.5, range: 0-1)

Response format:

```json
[
  {
    "episode_title": "Episode Title",
    "segment_text": "Transcript segment content...",
    "start_time": 123.45,
    "end_time": 167.89,
    "similarity": 0.85
  },
  // Additional results...
]
```

## Database Schema

This tool expects a Turso database with the following schema:

```sql
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
```

The `embedding` column should contain vector embeddings that can be used with the `vector_distance_cos` function.

## Development

### Setup

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Build the project:

```bash
npm run build
```

4. Run in development mode:

```bash
npm run dev
```

### Publishing

The project uses changesets for version management. To publish:

1. Create a changeset:

```bash
npm run changeset
```

2. Version the package:

```bash
npm run version
```

3. Publish to npm:

```bash
npm run release
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built on the [Model Context Protocol](https://github.com/modelcontextprotocol)
- Designed for efficient vector similarity search in transcript databases
