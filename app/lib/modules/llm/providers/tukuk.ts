import type { LanguageModel } from 'ai';
import { BaseProvider, getOpenAILikeModel } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import { logger } from '~/utils/logger';

/*
 * Provider "Tukuk" — dibina untuk projek Tukuk-OS.
 *
 * Ia menghala terus ke proksi OpenAI-compatible Tukuk-OS
 * (POST /api/agent/v1/chat/completions) yang membuat rotasi pembekal awan
 * (Groq gpt-oss-120b dll.) + menyokong function-calling untuk mod Agent.
 * Token = AGENT_TOKEN (lihat deploy/env.defaults induk tukuk-os).
 *
 * Boleh ditindih melalui env pelayan: TUKUK_API_BASE_URL / TUKUK_API_KEY.
 */

// URL proksi lalai — Tukuk-OS produksi.
const DEFAULT_TUKUK_BASE_URL = 'https://tukuk.org/api/agent/v1';

/*
 * Token bawaan ini = penanda TIER PERCUMA di pelayan (AGENT_FREE_TOKEN).
 * Ia SENGAJA awam (terbit di GitHub); pelayan melindunginya dengan had kadar
 * ketat (8/min/IP) + kekangan max_tokens — bukan kerahsiaan token. Klien yang
 * mempunyai Agent Token sebenar boleh menukar TUKUK_API_KEY melalui UI untuk
 * had penuh.
 */
const DEFAULT_TUKUK_TOKEN = '041a0832ab912f44e1814d326ac481e24c5928bc6e8c7089c043ea40cc32618d';

interface TukukModelsResponse {
  data: Array<{ id: string }>;
}

export default class TukukProvider extends BaseProvider {
  name = 'Tukuk';
  getApiKeyLink = 'https://tukuk.org/docs';
  labelForGetApiKey = 'Get Agent Token';

  config = {
    baseUrlKey: 'TUKUK_API_BASE_URL',
    apiTokenKey: 'TUKUK_API_KEY',
    baseUrl: DEFAULT_TUKUK_BASE_URL,
  };

  staticModels: ModelInfo[] = [
    {
      name: 'tukuk-agent-fast',
      label: 'Tukuk Agent Fast — respons kilat (LKM ringan)',
      provider: 'Tukuk',
      maxTokenAllowed: 16384,
    },
    {
      name: 'tukuk-agent',
      label: 'Tukuk Agent — rotasi awan (GPT-OSS-120B)',
      provider: 'Tukuk',
      maxTokenAllowed: 32768,
    },
  ];

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: 'TUKUK_API_BASE_URL',
      defaultApiTokenKey: 'TUKUK_API_KEY',
    });

    const token = apiKey || DEFAULT_TUKUK_TOKEN;

    if (!baseUrl || !token) {
      return this.staticModels;
    }

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: this.createTimeoutSignal(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const res = (await response.json()) as TukukModelsResponse;

      return res.data.map((model) => ({
        name: model.id,
        label:
          model.id === 'tukuk-agent'
            ? 'Tukuk Agent — rotasi awan (GPT-OSS-120B)'
            : model.id === 'tukuk-agent-fast'
              ? 'Tukuk Agent Fast — respons kilat (LKM ringan)'
              : model.id,
        provider: this.name,
        maxTokenAllowed: model.id === 'tukuk-agent-fast' ? 16384 : 32768,
      }));
    } catch (error) {
      // Proksi mati / tiada rangkaian — senarai statik masih guna biasa.
      logger.info(`${this.name}: gagal senarai /models, pakai statik`, error);
      return this.staticModels;
    }
  }

  getModelInstance(options: {
    model: string;
    serverEnv?: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModel {
    const { model, serverEnv, apiKeys, providerSettings } = options;
    const envRecord = this.convertEnvToRecord(serverEnv);

    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv: envRecord,
      defaultBaseUrlKey: 'TUKUK_API_BASE_URL',
      defaultApiTokenKey: 'TUKUK_API_KEY',
    });

    const finalBase = baseUrl || DEFAULT_TUKUK_BASE_URL;
    const finalToken = apiKey || DEFAULT_TUKUK_TOKEN;

    if (!finalToken) {
      throw new Error(`Missing configuration for ${this.name} provider`);
    }

    return getOpenAILikeModel(finalBase, finalToken, model);
  }
}
