import * as vscode from 'vscode';
import type { VariableInfo, Modification, FileType } from '../types';
import { getFileType, isQuotedText, removeQuotes } from '../utils';

// 텍스트 변환 서비스 클래스
class TextConversionService {
  private currentPreviewDecoration: vscode.TextEditorDecorationType | null = null;
  private savedModifications: Modification[] = [];
  private currentNamespace: string = '';

  // 네임스페이스 설정
  setNamespace(namespace: string): void {
    this.currentNamespace = namespace;
  }

  // 네임스페이스 가져오기
  getNamespace(): string {
    return this.currentNamespace;
  }

  // 커스텀 함수를 안전하게 실행하는 함수
  private executeCustomFunction(customCode: string, text: string): string {
    try {
      // 보안을 위해 Function 생성자 사용 (eval보다 안전)
      const customFunction = new Function('text', `return (${customCode})(text);`);
      const result = customFunction(text);

      // 결과가 문자열인지 확인
      if (typeof result !== 'string') {
        throw new Error('함수는 문자열을 반환해야 합니다.');
      }

      return result;
    } catch (error: any) {
      // 에러 발생 시 기본 변환 사용
      console.warn('커스텀 함수 실행 중 오류:', error);
      vscode.window.showWarningMessage(`키 생성 함수 오류: ${error.message}. 기본 변환을 사용합니다.`);

      // 기본 변환 로직
      return text
        .replace(/\s+/g, '_')
        .replace(/\./g, '#dot#')
        .replace(/\\(.)/g, '\\\\$1')
        .replace(/\[/g, '#lb#')
        .replace(/\]/g, '#rb#')
        .replace(/'/g, '#sq#')
        .replace(/"/g, '#dq#');
    }
  }

  // 변수 포함 텍스트를 i18n 형태로 변환
  private convertTextWithVariables(
    fileType: FileType,
    text: string,
    range: { start: number; end: number; text: string },
  ): string {
    const variableInfo = this.extractVariables(fileType, text);
    let i18nFunction: string;

    if (variableInfo.variables.length === 0) {
      // 변수가 없는 경우 기존 로직 사용
      const i18nKey = this.convertToI18nKey(text);
      const fullKey = this.currentNamespace ? `${this.currentNamespace}.${i18nKey}` : i18nKey;
      i18nFunction = `t('${fullKey}')`;
    } else {
      // 변수가 있는 경우 템플릿 기반으로 변환
      const templateKey = this.convertToI18nKey(variableInfo.template);
      const fullKey = this.currentNamespace ? `${this.currentNamespace}.${templateKey}` : templateKey;
      const variablesArray = variableInfo.variables.join(', ');
      i18nFunction = `t('${fullKey}', [${variablesArray}])`;
    }

    if (isQuotedText(text)) {
      return i18nFunction;
    }

    if (this.containsInlineMarkup(text)) {
      if (fileType === 'vue') {
        return `<span v-html="${i18nFunction}"></span>`;
      }
      if (fileType === 'tsx') {
        return `<span dangerouslySetInnerHTML={{ __html: ${i18nFunction} }} />`;
      }
    }

    const wrapperMap = {
      tsx: `{${i18nFunction}}`,
      vue: `{{${i18nFunction}}}`,
      ts: i18nFunction,
    };

    return wrapperMap[fileType] || i18nFunction;
  }

  // 공통 변환 로직: 수정사항 계산 및 선택적 하이라이트
  private processConversions(
    fileType: FileType,
    texts: string[],
    ranges: { start: number; end: number; text: string }[],
    shouldHighlight: boolean = false,
  ): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      if (shouldHighlight) {
        vscode.window.showWarningMessage('활성 편집기가 없습니다.');
      }
      return;
    }

    const document = editor.document;
    const decorations: vscode.DecorationOptions[] = [];

    // 수정사항 초기화
    this.savedModifications = [];

    // 중복 제거를 위해 처리된 범위 추적
    const processedRanges: { start: number; end: number }[] = [];

    // 각 텍스트에 대해 변환될 부분 계산
    texts.forEach((text) => {
      // 같은 텍스트에 해당하는 모든 범위 찾기
      const matchingRanges = ranges.filter((r) => r.text === text);

      matchingRanges.forEach((range) => {
        // 이미 처리된 범위와 겹치는지 확인
        const isOverlapping = processedRanges.some(
          (processed) => range.start < processed.end && range.end > processed.start,
        );

        if (!isOverlapping) {
          // 변수 포함 텍스트 변환
          const conversionPreview = this.convertTextWithVariables(fileType, text, range);

          // 수정사항 저장
          this.savedModifications.push({
            start: range.start,
            end: range.end,
            replacement: conversionPreview,
          });

          // 하이라이트가 필요한 경우 decoration 추가
          if (shouldHighlight) {
            const startPos = document.positionAt(range.start);
            const endPos = document.positionAt(range.end);

            decorations.push({
              range: new vscode.Range(startPos, endPos),
              hoverMessage: `변환 예정: "${text}" → ${conversionPreview}`,
              renderOptions: {
                before: {
                  contentText: `[변환예정] `,
                  color: '#ff6b6b',
                  fontWeight: 'bold',
                },
                after: {
                  contentText: ` → ${conversionPreview}`,
                  color: '#4ecdc4',
                  fontWeight: 'bold',
                },
              },
            });
          }

          // 처리된 범위에 추가
          processedRanges.push({ start: range.start, end: range.end });
        }
      });
    });

    // 하이라이트가 필요한 경우 decoration 적용
    if (shouldHighlight) {
      // 기존 미리보기 제거
      if (this.currentPreviewDecoration) {
        this.currentPreviewDecoration.dispose();
      }

      // 변환 예정 하이라이트 적용
      this.currentPreviewDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 107, 107, 0.1)',
        border: '1px solid #ff6b6b',
        borderRadius: '3px',
      });

      editor.setDecorations(this.currentPreviewDecoration, decorations);
    }
  }

  // 미리보기 로직을 내부적으로 실행하는 헬퍼 함수 (화면에 표시하지 않음)
  private calculateModifications(
    fileType: FileType,
    texts: string[],
    ranges: { start: number; end: number; text: string }[],
  ): void {
    this.processConversions(fileType, texts, ranges, false);
  }

  // 변환될 부분을 미리 하이라이트하는 함수
  highlightConversionTargets(texts: string[], ranges: { start: number; end: number; text: string }[]): void {
    const fileName = vscode.window.activeTextEditor?.document.fileName ?? '';
    const fileType = getFileType(fileName);
    if (!fileType) {
      return;
    }
    this.processConversions(fileType, texts, ranges, true);
  }

  // 미리보기 하이라이트 제거 함수
  clearConversionPreview(): void {
    if (this.currentPreviewDecoration) {
      this.currentPreviewDecoration.dispose();
      this.currentPreviewDecoration = null;
    }
  }

  // 미리보기에서 표시한 그대로 변환 적용
  async applyConversionFromPreview(
    texts: string[],
    ranges: { start: number; end: number; text: string }[],
  ): Promise<void> {
    if (texts.length === 0) {
      vscode.window.showInformationMessage('적용할 한글 텍스트가 없습니다.');
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('활성 편집기가 없습니다.');
      return;
    }

    const fileName = vscode.window.activeTextEditor?.document.fileName ?? '';
    const fileType = getFileType(fileName);
    if (!fileType) {
      vscode.window.showWarningMessage('파일 타입을 확인할 수 없습니다.');
      return;
    }

    // 미리보기 로직을 내부적으로 실행하여 수정사항 계산 (화면에 표시하지 않음)
    this.calculateModifications(fileType, texts, ranges);

    if (this.savedModifications.length === 0) {
      vscode.window.showInformationMessage('적용할 변환사항이 없습니다.');
      return;
    }

    const document = editor.document;
    const edit = new vscode.WorkspaceEdit();

    // 저장된 수정사항을 역순으로 적용 (뒤에서부터 앞으로)
    const sortedModifications = this.savedModifications.sort((a, b) => b.start - a.start);

    sortedModifications.forEach((mod) => {
      // props 바인딩 체크하여 mod 수정 (vue: key="{{t()}}" → :key="{t()}", tsx: key="{t()}" → key={t()})
      let finalMod = this.checkAndFixPropsBinding(fileType, mod, document);

      // 무의미한 문자열화 체크하여 mod 수정
      finalMod = this.checkAndFixUnnecessaryStringification(fileType, finalMod, document);

      const startPos = document.positionAt(finalMod.start);
      const endPos = document.positionAt(finalMod.end);
      const range = new vscode.Range(startPos, endPos);

      edit.replace(document.uri, range, finalMod.replacement);
    });

    // 모든 수정사항을 한 번에 적용
    await vscode.workspace.applyEdit(edit);

    this.clearConversionPreview();
  }

  // props 바인딩 체크하여 mod 수정
  private checkAndFixPropsBinding(fileType: FileType, mod: Modification, document: vscode.TextDocument): Modification {
    if (!fileType || (fileType !== 'vue' && fileType !== 'tsx')) {
      return mod;
    }

    const content = document.getText();

    // contextStart를 공백 또는 줄바꿈을 만날 때까지로 설정
    let contextStart = mod.start;
    while (contextStart > 0 && !/\s/.test(content[contextStart - 1])) {
      contextStart--;
    }

    // contextEnd를 공백 또는 >를 만날 때까지로 설정
    let contextEnd = mod.end;
    while (contextEnd < content.length && content[contextEnd] !== ' ' && content[contextEnd] !== '>') {
      contextEnd++;
    }

    // replacement를 포함한 전체 컨텍스트 생성 (변경된 후 기준)
    const beforeText = content.substring(contextStart, mod.start);
    const afterText = content.substring(mod.end, contextEnd);
    const fullContext = beforeText + mod.replacement + afterText;

    if (fileType === 'vue') {
      // Vue: mod.replacement가 {{}}로 감싸져 있는지 체크
      const isWrappedInDoubleBraces = mod.replacement.startsWith('{{') && mod.replacement.endsWith('}}');

      if (isWrappedInDoubleBraces) {
        // key="{{t()}}" 패턴이 포함되어 있는지 확인
        const vuePropsPattern = /(\w+(?:-\w+)*)="\{\{(t\(.*?\))\}\}"/;
        const match = fullContext.match(vuePropsPattern);
        if (match) {
          const [, propName, tFunction] = match;
          // 변경된 후 기준으로 :key="t()" 형태로 수정하고 범위도 조정
          return {
            start: contextStart,
            end: contextEnd,
            replacement: `:${propName}="${tFunction}"`,
          };
        }
      }
    } else if (fileType === 'tsx') {
      // TSX: mod.replacement가 {}로 감싸져 있는지 체크
      const isWrappedInBraces = mod.replacement.startsWith('{') && mod.replacement.endsWith('}');

      if (isWrappedInBraces) {
        // key="{t()}" 패턴이 포함되어 있는지 확인
        const tsxPropsPattern1 = /(\w+(?:-\w+)*)="\{(t\([^}]*\))\}"/;
        const match = fullContext.match(tsxPropsPattern1);
        if (match) {
          const [, propName, tFunction] = match;
          // 변경된 후 기준으로 key={t()} 형태로 수정하고 범위도 조정
          return {
            start: contextStart,
            end: contextEnd,
            replacement: `${propName}={${tFunction}}`,
          };
        }

        // key={`{t()}`} 패턴이 포함되어 있는지 확인
        const tsxPropsPattern2 = /(\w+(?:-\w+)*)=\{\`\{(t\([^`]*\))\}\`\}/;
        const templateMatch = fullContext.match(tsxPropsPattern2);
        if (templateMatch) {
          const [, propName, tFunction] = templateMatch;
          // 변경된 후 기준으로 key={t()} 형태로 수정하고 범위도 조정
          return {
            start: contextStart,
            end: contextEnd,
            replacement: `${propName}={${tFunction}}`,
          };
        }
      }
    }

    return mod;
  }

  // 무의미한 문자열화 패턴 체크하여 mod 수정
  private checkAndFixUnnecessaryStringification(
    fileType: FileType,
    mod: Modification,
    document: vscode.TextDocument,
  ): Modification {
    if (!fileType || (fileType !== 'vue' && fileType !== 'tsx')) {
      return mod;
    }

    const content = document.getText();

    // replacement 앞뒤로 하나씩만 확인
    const contextStart = Math.max(0, mod.start - 1);
    const contextEnd = Math.min(content.length, mod.end + 1);

    // replacement를 포함한 전체 컨텍스트 생성
    const beforeText = content.substring(contextStart, mod.start);
    const afterText = content.substring(mod.end, contextEnd);
    const fullContext = beforeText + mod.replacement + afterText;

    // 무의미한 문자열화 패턴들
    const unnecessaryStringificationPatterns = [
      // "{{t()}}"
      /"\{\{(t\(.*?\))\}\}"/,
      // '{{t()}}'
      /'\{\{(t\(.*?\))\}\}'/,
      // `{{t()}}`
      /`\{\{(t\(.*?\))\}\}`/,
      // "{t()}"
      /"\{t\(.*?\)\}"/,
      // '{t()}'
      /'\{t\(.*?\)\}'/,
      // `{t()}`
      /`\{t\(.*?\)\}`/,
    ];

    for (const pattern of unnecessaryStringificationPatterns) {
      const match = fullContext.match(pattern);
      if (match) {
        let replacement = mod.replacement;
        if (fileType === 'vue') {
          // Vue: {{t()}} → t()
          replacement = replacement.slice(2, -2);
        } else if (fileType === 'tsx') {
          // TSX: {t()} → t()
          replacement = replacement.slice(1, -1);
        }

        return {
          start: contextStart,
          end: contextEnd,
          replacement: replacement,
        };
      }
    }

    return mod;
  }

  private containsInlineMarkup(text: string): boolean {
    return /<\/?[a-zA-Z][^>]*>/.test(text);
  }

  // 텍스트에서 변수 추출 및 템플릿 생성
  extractVariables(fileType: FileType, text: string): VariableInfo {
    const variables: string[] = [];
    let template = text;
    let index = 0;

    // ${} 형태 변수 찾기
    const dollarMatches = text.matchAll(/\$\{\s*([^}]+)\s*\}/g);
    for (const match of dollarMatches) {
      const variableName = match[1].trim();
      variables.push(variableName);
      template = template.replace(match[0], `{${index}}`);
      index++;
    }

    if (fileType === 'vue') {
      // {{}} 형태 변수 찾기
      const braceMatches = text.matchAll(/\{\{\s*([^}]+)\s*\}\}/g);
      for (const match of braceMatches) {
        const variableName = match[1].trim();
        variables.push(variableName);
        template = template.replace(match[0], `{${index}}`);
        index++;
      }
    } else if (fileType === 'tsx') {
      // {} 형태 변수 찾기 (${} 형태 제외)
      const jsxBraceMatches = text.matchAll(/(?<!\$)\{\s*([^}]+)\s*\}/g);
      for (const match of jsxBraceMatches) {
        const variableName = match[1].trim();
        variables.push(variableName);
        template = template.replace(match[0], `{${index}}`);
        index++;
      }
    }

    return {
      originalText: text,
      variables,
      template,
    };
  }

  // 텍스트를 i18n 키로 변환하는 함수 (커스텀 함수 사용)
  convertToI18nKey(text: string): string {
    const config = vscode.workspace.getConfiguration('I18nSmartDDOCK.keyGeneration');
    const customFunction = config.get<string>(
      'customFunction',
      "text => text.replace(/\\s+/g, '_').replace(/\\./g, '#dot#').replace(/\\\\(.)/g, '\\\\\\\\$1').replace(/\\[/g, '#lb#').replace(/\\]/g, '#rb#').replace(/'/g, '#sq#').replace(/\"/g, '#dq#')",
    );

    // 따옴표로 감싸진 텍스트인 경우 시작과 끝의 따옴표 제거
    const cleanText = removeQuotes(text);

    return this.executeCustomFunction(customFunction, cleanText);
  }
}

const service = new TextConversionService();

export const extractVariables = (fileType: FileType, text: string) => service.extractVariables(fileType, text);
export const convertToI18nKey = (text: string) => service.convertToI18nKey(text);
export const setNamespace = (namespace: string) => service.setNamespace(namespace);
export const getNamespace = () => service.getNamespace();
export const highlightConversionTargets = (texts: string[], ranges: { start: number; end: number; text: string }[]) =>
  service.highlightConversionTargets(texts, ranges);
export const clearConversionPreview = () => service.clearConversionPreview();
export const applyConversionFromPreview = (texts: string[], ranges: { start: number; end: number; text: string }[]) =>
  service.applyConversionFromPreview(texts, ranges);
