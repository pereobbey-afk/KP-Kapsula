import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { requireUser } from '../auth.js';
import { fromMilliQty } from '../../shared/money.js';
import { listProjectEstimates, listProjectHistory } from '../../domain/estimate/repository.js';

export const projectInputSchema = z.object({
  name: z.string().min(1).max(200),
  areaM2: z.number().finite().positive().max(1_000_000).nullable().optional(),
  rooms: z.number().int().min(0).max(1000).nullable().optional(),
  initialState: z.enum(['concrete', 'white_box', 'secondary']).nullable().optional(),
  scopeLevel: z.string().max(500).nullable().optional(),
});

type ProjectRow = {
  id: string;
  user_id: string;
  name: string;
  area_milli: number | null;
  rooms: number | null;
  initial_state: string | null;
  scope_level: string | null;
  created_at: number;
  updated_at: number;
};

export function serializeProject(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    areaM2: row.area_milli === null ? null : fromMilliQty(row.area_milli),
    rooms: row.rooms,
    initialState: row.initial_state,
    scopeLevel: row.scope_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  /** История проектов пользователя с итогами последних смет. */
  app.get('/api/projects', async (request) => {
    const user = requireUser(request);

    const rows = db
      .prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200')
      .all(user.id) as ProjectRow[];

    return {
      projects: rows.map((row) => {
        const latest = db
          .prepare(
            `SELECT id, total_kopecks, revision, is_preliminary, created_at
               FROM estimates WHERE project_id = ? ORDER BY revision DESC LIMIT 1`,
          )
          .get(row.id) as
          | { id: string; total_kopecks: number; revision: number; is_preliminary: number; created_at: number }
          | undefined;

        return {
          ...serializeProject(row),
          latestEstimate: latest
            ? {
                id: latest.id,
                totalKopecks: latest.total_kopecks,
                revision: latest.revision,
                isPreliminary: latest.is_preliminary === 1,
                createdAt: latest.created_at,
              }
            : null,
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request) => {
    const user = requireUser(request);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.id) as
      | ProjectRow
      | undefined;
    // Чужой проект неотличим от несуществующего.
    if (!row || row.user_id !== user.id) throw new AppError('NOT_FOUND');

    return {
      project: serializeProject(row),
      estimates: listProjectEstimates(db, row.id).map((e) => ({
        id: e.id,
        revision: e.revision,
        totalKopecks: e.total_kopecks,
        pricePerM2Kopecks: e.price_per_m2_kopecks,
        isPreliminary: e.is_preliminary === 1,
        documentType: e.document_type,
        priceListLabel: e.price_list_label,
        createdAt: e.created_at,
      })),
      history: listProjectHistory(db, row.id).map((h) => ({
        id: h.id,
        action: h.action,
        estimateId: h.estimate_id,
        payload: h.payload_json ? (JSON.parse(h.payload_json) as unknown) : null,
        createdAt: h.created_at,
      })),
    };
  });
}
