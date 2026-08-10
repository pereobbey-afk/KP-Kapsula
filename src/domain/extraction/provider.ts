import Anthropic from '@anthropic-ai/sdk';
import { AppError, describeUnknown } from '../../shared/errors.js';
import { EXTRACTION_TOOL_SCHEMA, extractionResultSchema, type ExtractionResult } from './schema.js';
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildUserInstruction,
  renderCatalogue,
  type CatalogueEntry,
  type ObjectBrief,
} from './prompt.js';

/** Документ, передаваемый модели. */
export type ExtractionDocument = {
  filename: string;
  mime: string;
  /** Содержимое файла. */
  data: Buffer;
};

export type ExtractionRequest = {
  brief: ObjectBrief;
  catalogue: readonly CatalogueEntry[];
  documents: readonly ExtractionDocument[];
  /** Прерывание при отмене задачи или истечении аренды. */
  signal?: AbortSignal;
};

export type ExtractionOutcome = {
  result: ExtractionResult;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
};

/**
 * Провайдер извлечения. Интерфейс позволяет подменить реализацию
 * в unit-тестах, не подменяя её в интеграционных и e2e.
 */
export interface ExtractionProvider {
  extract(request: ExtractionRequest): Promise<ExtractionOutcome>;
}

const TOOL_NAME = 'extract_estimate_facts';

/** Типы файлов, которые модель принимает напрямую. */
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export class AnthropicExtractionProvider implements ExtractionProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: { apiKey: string; model: string; maxTokens?: number; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      // Ретраи на уровне SDK отключены: повторами управляет очередь задач,
      // иначе один запрос мог бы висеть дольше аренды воркера.
      maxRetries: 0,
    });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 16_000;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionOutcome> {
    const content: Anthropic.ContentBlockParam[] = [];

    for (const doc of request.documents) {
      if (doc.mime === 'application/pdf') {
        content.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: doc.data.toString('base64'),
          },
          title: doc.filename,
          // Явно помечаем документ как источник данных для цитирования.
          citations: { enabled: true },
        });
      } else if (IMAGE_MIMES.has(doc.mime)) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: doc.mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: doc.data.toString('base64'),
          },
        });
      } else {
        throw new AppError('UNSUPPORTED_FORMAT', { filename: doc.filename, mime: doc.mime });
      }
    }

    content.push({
      type: 'text',
      text: buildUserInstruction(request.brief, renderCatalogue(request.catalogue)),
    });

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: EXTRACTION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content }],
          tools: [
            {
              name: TOOL_NAME,
              description:
                'Возвращает извлечённые из документации факты об объёмах работ ' +
                'со ссылками на источник. Денежные суммы не возвращаются.',
              input_schema: EXTRACTION_TOOL_SCHEMA as Anthropic.Tool.InputSchema,
            },
          ],
          // Принудительный вызов инструмента: свободный текст вместо
          // структуры сломал бы дальнейший расчёт.
          tool_choice: { type: 'tool', name: TOOL_NAME },
        },
        request.signal ? { signal: request.signal } : {},
      );
    } catch (e) {
      throw mapProviderError(e);
    }

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === TOOL_NAME,
    );

    if (!toolUse) {
      throw new AppError('EXTRACTION_FAILED', {
        reason: 'Модель не вернула структурированный результат',
        stopReason: message.stop_reason,
      });
    }

    const parsed = extractionResultSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      // Ответ не прошёл схему — расчёт останавливается.
      // Чинить структуру «на лету» нельзя: это исказило бы смету.
      throw new AppError('EXTRACTION_SCHEMA_INVALID', {
        issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    return {
      result: parsed.data,
      model: this.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };
  }
}

/**
 * Приводит ошибку внешнего API к таксономии приложения.
 * Сырой ответ провайдера наружу не отдаётся никогда.
 */
export function mapProviderError(e: unknown): AppError {
  if (e instanceof AppError) return e;

  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    const raw = `${e.message ?? ''}`.toLowerCase();

    if (status === 401 || status === 403) {
      return new AppError('AI_NOT_CONFIGURED', { status, hint: 'ключ отклонён провайдером' });
    }
    if (status === 429) {
      return new AppError('AI_QUOTA_EXCEEDED', { status });
    }
    if (status === 402 || raw.includes('credit') || raw.includes('billing')) {
      return new AppError('AI_BILLING_PROBLEM', { status });
    }
    if (status === 413) {
      return new AppError('FILE_TOO_LARGE', { status, hint: 'документ превышает лимит провайдера' });
    }
    if (status === 400) {
      // Чаще всего — нечитаемый или защищённый PDF.
      if (raw.includes('pdf') && (raw.includes('encrypt') || raw.includes('password'))) {
        return new AppError('PDF_PASSWORD_PROTECTED', { status });
      }
      if (raw.includes('pdf') || raw.includes('document')) {
        return new AppError('PDF_CORRUPTED', { status });
      }
      return new AppError('EXTRACTION_FAILED', { status, detail: describeUnknown(e) });
    }
    if (status >= 500 || status === 529) {
      return new AppError('AI_UNAVAILABLE', { status });
    }
    return new AppError('AI_UNAVAILABLE', { status, detail: describeUnknown(e) });
  }

  if (e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.APIConnectionTimeoutError) {
    return new AppError('NETWORK_TEMPORARY', { detail: describeUnknown(e) });
  }

  if (e instanceof Error && e.name === 'AbortError') {
    return new AppError('JOB_CANCELLED');
  }

  return new AppError('AI_UNAVAILABLE', { detail: describeUnknown(e) });
}

/** Создаёт провайдера или сообщает, что ИИ не настроен. */
export function createExtractionProvider(opts: {
  apiKey: string | undefined;
  model: string;
  baseURL?: string | undefined;
}): ExtractionProvider {
  if (!opts.apiKey) {
    return {
      extract() {
        return Promise.reject(new AppError('AI_NOT_CONFIGURED'));
      },
    };
  }
  return new AnthropicExtractionProvider({
    apiKey: opts.apiKey,
    model: opts.model,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
}
