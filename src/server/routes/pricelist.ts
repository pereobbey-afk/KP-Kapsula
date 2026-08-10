import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { requireAdmin, requireUser } from '../auth.js';
import {
  activateVersion,
  getActiveVersionOrNull,
  importPriceList,
  listVersions,
  searchActiveItems,
} from '../../domain/pricelist/repository.js';

const rowSchema = z.object({
  section: z.string().max(300).nullable().optional(),
  sectionNo: z.number().int().nullable().optional(),
  code: z.string().max(64).nullable().optional(),
  name: z.string().max(500).nullable().optional(),
  unit: z.string().max(64).nullable().optional(),
  price: z.union([z.string().max(64), z.number(), z.null()]).optional(),
  sourceRow: z.string().max(120).nullable().optional(),
});

const importSchema = z.object({
  label: z.string().min(1).max(200),
  effectiveDate: z.string().max(40).nullable().optional(),
  sourceNote: z.string().max(1000).nullable().optional(),
  activate: z.boolean().optional(),
  editions: z
    .array(
      z.object({
        label: z.string().min(1).max(200),
        effectiveDate: z.string().min(4).max(40),
        rows: z.array(rowSchema).max(50_000),
      }),
    )
    .min(1)
    .max(20),
});

export async function registerPriceListRoutes(app: FastifyInstance): Promise<void> {
  const { db, logger } = app.ctx;

  /** Активная версия — её видно в смете и в интерфейсе. */
  app.get('/api/pricelist/active', async (request) => {
    requireUser(request);
    const active = getActiveVersionOrNull(db);
    if (!active) throw new AppError('PRICE_LIST_MISSING');

    return {
      version: {
        id: active.id,
        label: active.label,
        effectiveDate: active.effective_date,
        itemsCount: active.items_count,
        sectionsCount: active.sections_count,
        sourceNote: active.source_note,
        createdAt: active.created_at,
      },
    };
  });

  /** Поиск работ для ручного добавления строки в смету. */
  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/pricelist/items', async (request) => {
    requireUser(request);
    const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 200);
    return { items: searchActiveItems(db, request.query.q ?? '', limit) };
  });

  app.get('/api/pricelist/versions', async (request) => {
    requireAdmin(request);
    return {
      versions: listVersions(db).map((v) => ({
        id: v.id,
        label: v.label,
        effectiveDate: v.effective_date,
        isActive: v.is_active === 1,
        itemsCount: v.items_count,
        sectionsCount: v.sections_count,
        createdAt: v.created_at,
        report: v.import_report ? (JSON.parse(v.import_report) as unknown) : null,
      })),
    };
  });

  /**
   * Импорт прайса.
   *
   * Принимает уже разобранные строки редакций. Разбор .xlsx выполняет
   * CLI `npm run pricelist:import`, чтобы формат исходного файла
   * не влиял на серверный контракт.
   */
  app.post(
    '/api/pricelist/import',
    { bodyLimit: 32 * 1024 * 1024 },
    async (request) => {
      const admin = requireAdmin(request);
      const body = importSchema.safeParse(request.body);
      if (!body.success) {
        throw new AppError('VALIDATION_FAILED', {
          issues: body.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }

      const result = importPriceList(db, {
        label: body.data.label,
        effectiveDate: body.data.effectiveDate ?? null,
        sourceNote: body.data.sourceNote ?? null,
        editions: body.data.editions,
        createdBy: admin.id,
        activate: body.data.activate ?? false,
      });

      logger.info('Прайс-лист импортирован', {
        requestId: request.requestId,
        versionId: result.versionId,
        items: result.report.totalItems,
        sections: result.report.totalSections,
        overridden: result.report.overridden.length,
        rejected: result.report.rejected.length,
        activated: result.activated,
      });

      return result;
    },
  );

  app.post<{ Params: { id: string } }>('/api/pricelist/versions/:id/activate', async (request) => {
    requireAdmin(request);
    activateVersion(db, request.params.id);
    logger.info('Активирована версия прайса', {
      requestId: request.requestId,
      versionId: request.params.id,
    });
    return { ok: true };
  });
}
