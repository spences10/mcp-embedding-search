#!/usr/bin/env node

import { createClient } from '@libsql/client';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
	readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
);
const { name, version } = pkg;

// Environment variables
const db_url = process.env.TURSO_URL;
const db_auth_token = process.env.TURSO_AUTH_TOKEN;
const voyage_api_key = process.env.VOYAGE_API_KEY;

if (!db_url || !db_auth_token) {
	console.error(
		'Error: TURSO_URL and TURSO_AUTH_TOKEN environment variables are required',
	);
	process.exit(1);
}

if (!voyage_api_key) {
	console.error(
		'Error: VOYAGE_API_KEY environment variable is required for embedding generation',
	);
	process.exit(1);
}

// Create database client
const db_client = createClient({
	url: db_url,
	authToken: db_auth_token,
});

// Interface for search parameters
interface SearchParams {
	question: string;
	limit?: number;
	min_score?: number;
}

// Interface for search results
interface SearchResult {
	episode_title: string;
	segment_text: string;
	start_time: number;
	end_time: number;
	similarity: number;
}

/**
 * Generate embeddings for a text using Voyage API
 * @param text Text to generate embeddings for
 * @returns Array of numbers representing the embedding
 */
async function generate_embedding(text: string): Promise<number[]> {
	try {
		console.error(`Generating embedding for: "${text}"`);

		const response = await fetch(
			'https://api.voyageai.com/v1/embeddings',
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${voyage_api_key}`,
				},
				body: JSON.stringify({
					model: 'voyage-01',
					input: text,
				}),
			},
		);

		if (!response.ok) {
			const error_text = await response.text();
			throw new Error(
				`Voyage API error: ${response.status} ${error_text}`,
			);
		}

		const data = await response.json();
		console.error('Embedding generated successfully');

		return data.data[0].embedding;
	} catch (error) {
		console.error('Error generating embedding:', error);
		throw new McpError(
			ErrorCode.InternalError,
			`Failed to generate embedding: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * Search for relevant transcript segments using vector similarity
 * @param params Search parameters
 * @returns Array of search results
 */
async function search_embeddings(
	params: SearchParams,
): Promise<SearchResult[]> {
	const { question, limit = 5, min_score = 0.5 } = params;

	try {
		console.error(
			`Searching for: "${question}" with limit: ${limit}, min_score: ${min_score}`,
		);

		// Generate embedding for the question
		const query_embedding = await generate_embedding(question);
		console.error(
			`Generated embedding with ${query_embedding.length} dimensions`,
		);

		// Get total count of embeddings
		const count_result = await db_client.execute(
			'SELECT COUNT(*) as count FROM embeddings',
		);

		const total_count = Number((count_result.rows[0] as any)[0]);
		console.error(`Total embeddings in database: ${total_count}`);

		// If no embeddings in database, fall back to simple query
		if (total_count === 0) {
			console.error(
				'No embeddings found in database, using simple query',
			);

			const result = await db_client.execute({
				sql: `
          SELECT
            t.episode_title,
            t.segment_text,
            t.start_time,
            t.end_time,
            0.95 AS similarity
          FROM
            transcripts t
          LIMIT ?;
        `,
				args: [limit],
			});

			console.error(`Found ${result.rows.length} results`);

			// Process and return the results
			const search_results: SearchResult[] = [];

			for (const row of result.rows) {
				search_results.push({
					episode_title: row.episode_title as string,
					segment_text: row.segment_text as string,
					start_time: row.start_time as number,
					end_time: row.end_time as number,
					similarity: row.similarity as number,
				});
			}

			return search_results;
		}

		// First, check if we have a vector index
		const index_check = await db_client.execute({
			sql: `
				SELECT name FROM sqlite_master 
				WHERE type='index' AND name='embeddings_vector_idx';
			`,
			args: [],
		});
		
		const has_vector_index = index_check.rows.length > 0;
		console.error(`Vector index exists: ${has_vector_index}`);
		
		let results;
		
		if (has_vector_index) {
			// Use vector index for efficient search
			console.error('Using vector index for search');
			results = await db_client.execute({
				sql: `
					WITH vector_search AS (
						SELECT rowid, similarity
						FROM vector_top_k('embeddings_vector_idx', vector32(?), ?)
					)
					SELECT
						t.episode_title,
						t.segment_text,
						t.start_time,
						t.end_time,
						vs.similarity
					FROM
						vector_search vs
					JOIN
						embeddings e ON e.id = vs.rowid
					JOIN
						transcripts t ON e.transcript_id = t.id
					WHERE
						vs.similarity >= ?
					ORDER BY
						vs.similarity DESC;
				`,
				args: [
					JSON.stringify(query_embedding),
					limit * 2, // Get more results than needed to filter by min_score
					min_score,
				],
			});
		} else {
			// Try different embedding formats since we don't know the exact format
			console.error('No vector index found, trying direct vector comparison');
			
			try {
				// First try with json_extract for $.vector format
				results = await db_client.execute({
					sql: `
						SELECT
							t.episode_title,
							t.segment_text,
							t.start_time,
							t.end_time,
							(1 - vector_distance_cos(json_extract(e.embedding, '$.vector'), vector32(?))) AS similarity
						FROM
							embeddings e
						JOIN
							transcripts t ON e.transcript_id = t.id
						WHERE
							(1 - vector_distance_cos(json_extract(e.embedding, '$.vector'), vector32(?))) >= ?
						ORDER BY
							similarity DESC
						LIMIT ?;
					`,
					args: [
						JSON.stringify(query_embedding),
						JSON.stringify(query_embedding),
						min_score,
						limit,
					],
				});
				
				console.error(`Found ${results.rows.length} results with $.vector format`);
			} catch (error) {
				console.error('Error with $.vector format, trying direct embedding:', error);
				
				// If that fails, try with direct embedding (assuming it's already a JSON array)
				results = await db_client.execute({
					sql: `
						SELECT
							t.episode_title,
							t.segment_text,
							t.start_time,
							t.end_time,
							(1 - vector_distance_cos(e.embedding, vector32(?))) AS similarity
						FROM
							embeddings e
						JOIN
							transcripts t ON e.transcript_id = t.id
						WHERE
							(1 - vector_distance_cos(e.embedding, vector32(?))) >= ?
						ORDER BY
							similarity DESC
						LIMIT ?;
					`,
					args: [
						JSON.stringify(query_embedding),
						JSON.stringify(query_embedding),
						min_score,
						limit,
					],
				});
				
				console.error(`Found ${results.rows.length} results with direct embedding format`);
			}
		}

		console.error(`Found ${results.rows.length} results above threshold`);

		// Process and return the results
		const search_results: SearchResult[] = [];

		for (const row of results.rows) {
			search_results.push({
				episode_title: row.episode_title as string,
				segment_text: row.segment_text as string,
				start_time: row.start_time as number,
				end_time: row.end_time as number,
				similarity: row.similarity as number,
			});
		}

		return search_results;
	} catch (error) {
		console.error('Database query error:', error);
		throw new McpError(
			ErrorCode.InternalError,
			`Database query failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

// MCP Server implementation
class EmbeddingSearchServer {
	private server: Server;

	constructor() {
		this.server = new Server(
			{
				name,
				version,
			},
			{
				capabilities: {
					tools: {},
				},
			},
		);

		// Set up request handlers
		this.setup_handlers();

		// Error handling
		this.server.onerror = (error) => {
			console.error('MCP Server error:', error);
		};

		// Handle process termination
		process.on('SIGINT', async () => {
			await this.server.close();
			process.exit(0);
		});
	}

	private setup_handlers() {
		// List available tools
		this.server.setRequestHandler(
			ListToolsRequestSchema,
			async () => ({
				tools: [
					{
						name: 'search_embeddings',
						description:
							'Search for relevant transcript segments using vector similarity',
						inputSchema: {
							type: 'object',
							properties: {
								question: {
									type: 'string',
									description: 'The query text to search for',
								},
								limit: {
									type: 'number',
									description:
										'Number of results to return (default: 5)',
									minimum: 1,
									maximum: 50,
								},
								min_score: {
									type: 'number',
									description:
										'Minimum similarity threshold (default: 0.5)',
									minimum: 0,
									maximum: 1,
								},
							},
							required: ['question'],
						},
					},
				],
			}),
		);

		// Handle tool calls
		this.server.setRequestHandler(
			CallToolRequestSchema,
			async (request) => {
				if (request.params.name !== 'search_embeddings') {
					throw new McpError(
						ErrorCode.MethodNotFound,
						`Unknown tool: ${request.params.name}`,
					);
				}

				const args = request.params.arguments;

				// Validate arguments
				if (
					typeof args !== 'object' ||
					args === null ||
					typeof args.question !== 'string'
				) {
					throw new McpError(
						ErrorCode.InvalidParams,
						'Invalid parameters: question is required and must be a string',
					);
				}

				// Extract and validate parameters
				const params: SearchParams = {
					question: args.question,
				};

				if (args.limit !== undefined) {
					if (
						typeof args.limit !== 'number' ||
						args.limit < 1 ||
						args.limit > 50
					) {
						throw new McpError(
							ErrorCode.InvalidParams,
							'Invalid limit parameter: must be a number between 1 and 50',
						);
					}
					params.limit = args.limit;
				}

				if (args.min_score !== undefined) {
					if (
						typeof args.min_score !== 'number' ||
						args.min_score < 0 ||
						args.min_score > 1
					) {
						throw new McpError(
							ErrorCode.InvalidParams,
							'Invalid min_score parameter: must be a number between 0 and 1',
						);
					}
					params.min_score = args.min_score;
				}

				try {
					// Perform the search
					const results = await search_embeddings(params);

					// Handle empty results
					if (results.length === 0) {
						return {
							content: [
								{
									type: 'text',
									text: 'No matching transcript segments found.',
								},
							],
						};
					}

					// Format the results
					return {
						content: [
							{
								type: 'text',
								text: JSON.stringify(results, null, 2),
							},
						],
					};
				} catch (error) {
					console.error('Error processing search request:', error);

					if (error instanceof McpError) {
						throw error;
					}

					throw new McpError(
						ErrorCode.InternalError,
						`Error processing search request: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			},
		);
	}

	async run() {
		try {
			// Test database connection
			await db_client.execute({ sql: 'SELECT 1', args: [] });
			console.error('Database connection successful');

			// Start the server
			const transport = new StdioServerTransport();
			await this.server.connect(transport);
			console.error(
				`${name} v${version} MCP server running on stdio`,
			);
		} catch (error) {
			console.error('Failed to start server:', error);
			process.exit(1);
		}
	}
}

// Start the server
const server = new EmbeddingSearchServer();
server.run().catch((error) => {
	console.error('Server runtime error:', error);
	process.exit(1);
});
