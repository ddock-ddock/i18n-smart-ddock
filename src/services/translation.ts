import type { TranslationService } from '../types';
import { removeQuotes } from '../utils';

// DeepL 번역 서비스
class DeepLTranslationService implements TranslationService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  // {{ }} / ${} / {expr} 는 번역에서 빼고, 문장 안의 태그는 유지한다.
  private protectInterpolations(text: string): { text: string; placeholders: string[] } {
    const placeholders: string[] = [];
    const protect = (match: string) => {
      const token = `<x id="${placeholders.length}"/>`;
      placeholders.push(match);
      return token;
    };

    let protectedText = text.replace(/\{\{[\s\S]*?\}\}/g, protect);
    protectedText = protectedText.replace(/\$\{[\s\S]*?\}/g, protect);
    protectedText = protectedText.replace(/\{[^{}\n<>]+\}/g, protect);
    return { text: protectedText, placeholders };
  }

  private restoreInterpolations(text: string, placeholders: string[]): string {
    if (placeholders.length === 0) {
      return text;
    }
    return text.replace(/<x\s+id=["'](\d+)["']\s*(?:\/>|>\s*<\/x>)/gi, (match, id) => {
      const placeholder = placeholders[Number(id)];
      return placeholder ?? match;
    });
  }

  async translate(text: string, targetLang: string): Promise<string> {
    const languageMap: { [key: string]: string } = {
      en: 'EN',
      ja: 'JA',
      ko: 'KO',
      zh: 'ZH',
    };

    const targetLanguage = languageMap[targetLang] || targetLang;
    const targetText = removeQuotes(text);
    const { text: protectedText, placeholders } = this.protectInterpolations(targetText);
    const hasMarkup = placeholders.length > 0 || /<\/?[a-zA-Z][^>]*>/.test(protectedText);

    try {
      const params: Record<string, string> = {
        text: protectedText,
        target_lang: targetLanguage,
        source_lang: 'KO', // 한국어에서 번역
      };
      if (hasMarkup) {
        params.tag_handling = 'html';
      }

      const response = await fetch('https://api-free.deepl.com/v2/translate', {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${this.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params),
      });

      if (!response.ok) {
        throw new Error(`DeepL API 오류: ${response.status}`);
      }

      const data = (await response.json()) as any;
      return this.restoreInterpolations(data.translations[0].text, placeholders);
    } catch (error) {
      console.error('DeepL 번역 오류:', error);
      throw error;
    }
  }
}

// 번역 서비스 팩토리
class TranslationServiceFactory {
  static createService(provider: string, apiKey: string): TranslationService {
    if (!apiKey) {
      throw new Error('DeepL API 키가 필요합니다.');
    }

    switch (provider.toLowerCase()) {
      case 'deepl':
        return new DeepLTranslationService(apiKey);
      default:
        throw new Error(`지원하지 않는 번역 서비스: ${provider}`);
    }
  }
}

// 번역 매니저 클래스
class TranslationManager {
  private service: TranslationService;

  constructor(provider: string, apiKey: string) {
    this.service = TranslationServiceFactory.createService(provider, apiKey);
  }

  async translateTexts(
    texts: string[],
    targetLang: string,
    progressCallback?: (current: number, total: number) => void,
  ): Promise<string[]> {
    const results: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];

      // 진행 상황 콜백 호출
      if (progressCallback) {
        progressCallback(i + 1, texts.length);
      }

      try {
        const translated = await this.service.translate(text, targetLang);
        results.push(translated);
      } catch (error) {
        console.error(`번역 실패 (${text}):`, error);
        results.push(text); // 번역 실패 시 원본 반환
      }
    }

    return results;
  }
}

export async function translateTexts(
  texts: string[],
  targetLang: string,
  provider: string,
  apiKey: string,
  progressCallback?: (current: number, total: number) => void,
): Promise<string[]> {
  const service = new TranslationManager(provider, apiKey);
  return service.translateTexts(texts, targetLang, progressCallback);
}
