import type { TextRange, ExtractedTexts, FileType } from '../types';
import { removeQuotes } from '../utils';

type InlineTagKind = 'inline' | 'block' | 'other' | 'skip';

interface TemplateTag {
  start: number;
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

interface TemplateNode {
  type: 'text' | 'element';
  start: number;
  end: number;
  name?: string;
  kind?: InlineTagKind;
  openEnd?: number;
  closeStart?: number;
  children: TemplateNode[];
}

const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
]);

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'button',
  'caption',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'template',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

class KoreanExtractionService {
  // 주석 제거 함수 (위치 매핑 정보도 반환)
  private removeCommentsWithMapping(text: string): {
    processedText: string;
    positionMap: number[];
  } {
    let result = '';
    const positionMap: number[] = [];

    // HTML 주석 제거 (<!-- -->)
    const htmlCommentRegex = /<!--[\s\S]*?-->/g;
    let match;
    let lastIndex = 0;

    while ((match = htmlCommentRegex.exec(text)) !== null) {
      // 주석 이전 부분 추가
      result += text.substring(lastIndex, match.index);
      // 위치 매핑 추가
      for (let i = lastIndex; i < match.index; i++) {
        positionMap.push(i);
      }
      lastIndex = match.index + match[0].length;
    }

    // 마지막 주석 이후 부분 추가
    result += text.substring(lastIndex);
    for (let i = lastIndex; i < text.length; i++) {
      positionMap.push(i);
    }

    // 한 줄 주석 제거 (//)
    const singleLineCommentRegex = /\/\/.*$/gm;
    lastIndex = 0;
    let newResult = '';
    const newPositionMap: number[] = [];

    while ((match = singleLineCommentRegex.exec(result)) !== null) {
      // 주석 이전 부분 추가
      newResult += result.substring(lastIndex, match.index);
      // 위치 매핑 추가
      for (let i = lastIndex; i < match.index; i++) {
        newPositionMap.push(positionMap[i]);
      }
      lastIndex = match.index + match[0].length;
    }

    // 마지막 주석 이후 부분 추가
    newResult += result.substring(lastIndex);
    for (let i = lastIndex; i < result.length; i++) {
      newPositionMap.push(positionMap[i]);
    }

    result = newResult;

    // 블록 주석 제거 (/* */)
    const blockCommentRegex = /\/\*[\s\S]*?\*\//g;
    lastIndex = 0;
    newResult = '';
    const finalPositionMap: number[] = [];

    while ((match = blockCommentRegex.exec(result)) !== null) {
      // 주석 이전 부분 추가
      newResult += result.substring(lastIndex, match.index);
      // 위치 매핑 추가
      for (let i = lastIndex; i < match.index; i++) {
        finalPositionMap.push(newPositionMap[i]);
      }
      lastIndex = match.index + match[0].length;
    }

    // 마지막 주석 이후 부분 추가
    newResult += result.substring(lastIndex);
    for (let i = lastIndex; i < result.length; i++) {
      finalPositionMap.push(newPositionMap[i]);
    }

    return { processedText: newResult, positionMap: finalPositionMap };
  }

  // 괄호 매칭을 수동으로 처리하는 함수
  private findMatchingBracket(text: string, startIndex: number, openChar: string, closeChar: string): number {
    let depth = 0;
    let i = startIndex;

    while (i < text.length) {
      if (text[i] === openChar) {
        depth++;
      } else if (text[i] === closeChar) {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
      i++;
    }

    return -1; // 매칭되는 괄호를 찾지 못함
  }

  // i18n 적용된 부분 찾기
  private findI18nRanges(text: string): TextRange[] {
    const i18nRanges: TextRange[] = [];

    // t() 함수 호출 패턴 찾기 - 수동으로 괄호 매칭 처리
    const tFunctionPattern = /\bt\(/g;
    let match;

    while ((match = tFunctionPattern.exec(text)) !== null) {
      const start = match.index!;

      // 매칭되는 ')' 찾기
      const funcEnd = this.findMatchingBracket(text, start + 1, '(', ')');

      if (funcEnd !== -1) {
        const fullMatch = text.substring(start, funcEnd + 1);

        // 첫 번째 인자 추출 - 수동으로 따옴표 쌍 찾기
        let i18nText = '';
        const argsStart = start + 2; // t( 다음부터
        const argsEnd = funcEnd; // ) 이전까지

        // 첫 번째 인자 시작 위치 찾기 (공백/줄바꿈 건너뛰기)
        let argStart = argsStart;
        while (argStart < argsEnd && /\s/.test(text[argStart])) {
          argStart++;
        }

        if (argStart < argsEnd) {
          const firstChar = text[argStart];

          // 따옴표로 시작하는 경우
          if (firstChar === '"' || firstChar === "'" || firstChar === '`') {
            const quoteType = firstChar;
            let quoteEnd = argStart + 1;

            // 닫는 따옴표 찾기 (이스케이프 처리)
            while (quoteEnd < argsEnd) {
              if (text[quoteEnd] === quoteType && text[quoteEnd - 1] !== '\\') {
                break;
              }
              quoteEnd++;
            }

            if (quoteEnd < argsEnd) {
              // 따옴표 내용 추출
              i18nText = text.substring(argStart + 1, quoteEnd);
            }
          }
        }

        // 한글이 포함된 경우만 처리
        if (i18nText && /[가-힣]/.test(i18nText)) {
          // 중복 체크
          const isDuplicate = i18nRanges.some((range) => range.start === start && range.end === funcEnd + 1);

          if (!isDuplicate) {
            i18nRanges.push({
              start: start,
              end: funcEnd + 1,
              text: i18nText,
            });
          }
        }
      }
    }

    return i18nRanges;
  }

  // TypeScript 파일에서 한글 찾기 (위치 매핑 포함)
  private findKoreanInTsFileWithMapping(
    processedText: string,
    positionMap: number[],
    excludeRanges: { start: number; end: number }[] = [],
  ): TextRange[] {
    const koreanRanges: TextRange[] = [];

    // 1. 따옴표 안의 한글 처리 - 수동으로 따옴표 쌍 찾기
    let i = 0;
    while (i < processedText.length) {
      // 제외 범위 내부인지 확인
      const isInExcludeRange = excludeRanges.some((range) => i >= range.start && i < range.end);
      if (isInExcludeRange) {
        i++;
        continue;
      }

      const char = processedText[i];

      // 따옴표 시작 찾기
      if (char === '"' || char === "'" || char === '`') {
        const quoteType = char;
        const start = i;
        i++; // 따옴표 다음부터 시작

        // 닫는 따옴표 찾기
        let content = '';
        while (i < processedText.length && processedText[i] !== quoteType) {
          content += processedText[i];
          i++;
        }

        // 닫는 따옴표를 찾았고, 내용에 한글이 있으면
        if (i < processedText.length && /[가-힣]/.test(content)) {
          const end = i;
          // 따옴표를 포함한 전체 텍스트 저장
          const koreanText = quoteType + content + quoteType;

          // 원본 텍스트에서 해당 위치 찾기
          const originalStart = positionMap[start];
          const originalEnd = positionMap[end] + 1;

          if (koreanText) {
            koreanRanges.push({
              start: originalStart,
              end: originalEnd,
              text: koreanText,
            });
          }
        }
      }
      i++;
    }

    // 2. 공백 없는 순수 한글 변수 처리
    // 이미 처리된 범위들을 추적
    const processedRanges: { start: number; end: number }[] = [];
    koreanRanges.forEach((range) => {
      processedRanges.push({ start: range.start, end: range.end });
    });

    // 한글 변수 패턴 찾기 (공백 없는 순수 한글)
    for (let i = 0; i < processedText.length; i++) {
      // 제외 범위 내부인지 확인
      const isInExcludeRange = excludeRanges.some((range) => i >= range.start && i < range.end);
      if (isInExcludeRange) {
        continue;
      }

      const char = processedText[i];

      // 이미 처리된 범위에 포함되는지 확인
      const originalPos = positionMap[i];
      const isAlreadyProcessed = processedRanges.some((range) => originalPos >= range.start && originalPos < range.end);

      if (isAlreadyProcessed) {
        continue;
      }

      // 한글이면 연속된 한글 찾기
      if (/[가-힣]/.test(char)) {
        let koreanStart = i;
        let koreanEnd = i;

        // 연속된 한글 찾기
        while (koreanEnd < processedText.length && /[가-힣]/.test(processedText[koreanEnd])) {
          koreanEnd++;
        }

        // 한글 변수인지 확인 (앞뒤로 공백이나 특수문자가 있어야 함)
        const beforeChar = koreanStart > 0 ? processedText[koreanStart - 1] : ' ';
        const afterChar = koreanEnd < processedText.length ? processedText[koreanEnd] : ' ';

        // 한글 변수 조건: 앞뒤로 공백, 괄호, 콜론, 콤마 등이 있어야 함
        if (/[\s\[\]{}():,;=]/.test(beforeChar) && /[\s\[\]{}():,;=]/.test(afterChar)) {
          const koreanText = processedText.substring(koreanStart, koreanEnd);

          // 원본 텍스트에서 해당 위치 찾기
          const originalStart = positionMap[koreanStart];
          const originalEnd = positionMap[koreanEnd - 1] + 1;

          koreanRanges.push({
            start: originalStart,
            end: originalEnd,
            text: koreanText,
          });

          // 처리된 범위에 추가
          processedRanges.push({ start: originalStart, end: originalEnd });
        }

        // 다음 문자로 이동
        i = koreanEnd - 1;
      }
    }

    return koreanRanges;
  }

  // 한글 텍스트 위치 찾기 (위치 매핑 포함) - Vue 파일용
  private findKoreanInVueFileWithMapping(processedText: string, positionMap: number[]): TextRange[] {
    // 1. style 태그 제거
    const textWithoutStyle = processedText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // 2. script 태그 범위 찾기
    const scriptRanges = this.findScriptRanges(textWithoutStyle);

    // 3. script 태그 내부 한글 텍스트 추출
    const scriptKoreanRanges = this.extractKoreanFromScriptTags(textWithoutStyle, positionMap, scriptRanges);

    // 4. Vue 템플릿에서 한글 텍스트 추출
    const templateKoreanRanges = this.extractKoreanFromHtmlTemplate(textWithoutStyle, positionMap, scriptRanges, 'vue');

    // 5. 결과 합치기
    return [...scriptKoreanRanges, ...templateKoreanRanges];
  }

  // script 태그 범위 찾기
  private findScriptRanges(text: string): { start: number; end: number }[] {
    const scriptRanges: { start: number; end: number }[] = [];
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = scriptRegex.exec(text)) !== null) {
      const scriptStart = match.index + match[0].indexOf('>') + 1; // > 다음부터
      const scriptEnd = match.index + match[0].lastIndexOf('</script>'); // </script> 전까지

      scriptRanges.push({
        start: scriptStart,
        end: scriptEnd,
      });
    }

    return scriptRanges;
  }

  // script 태그 내부 한글 텍스트 추출
  private extractKoreanFromScriptTags(
    processedText: string,
    positionMap: number[],
    scriptRanges: { start: number; end: number }[],
  ): TextRange[] {
    const koreanRanges: TextRange[] = [];

    for (const scriptRange of scriptRanges) {
      const scriptContent = processedText.substring(scriptRange.start, scriptRange.end);
      const scriptPositionMap = positionMap.slice(scriptRange.start, scriptRange.end);

      const scriptKoreanRanges = this.findKoreanInTsFileWithMapping(scriptContent, scriptPositionMap);

      koreanRanges.push(...scriptKoreanRanges);
    }

    return koreanRanges;
  }

  /**
   * 변수 내용에서 한글 텍스트 추출
   */
  private extractKoreanFromVariableContent(
    content: string,
    variableStart: number,
    offset: number, // Vue는 2, TSX는 1
  ): TextRange[] {
    const koreanRanges: TextRange[] = [];

    // 1. 따옴표로 감싸진 한글 텍스트 찾기
    const quotedKoreanMatches = content.match(/['"`][^'"`]*[가-힣][^'"`]*['"`]/g);
    if (quotedKoreanMatches) {
      for (const quotedText of quotedKoreanMatches) {
        const quotedIndex = content.indexOf(quotedText);
        const absoluteStart = variableStart + quotedIndex + offset;
        const absoluteEnd = absoluteStart + quotedText.length;

        koreanRanges.push({
          start: absoluteStart,
          end: absoluteEnd,
          text: quotedText,
        });
      }
    }

    // 2. HTML 태그의 inner text 찾기
    const htmlInnerTextRegex = /<[^>]*>([^<]*[가-힣][^<]*)<\/[^>]*>/g;
    let htmlMatch;
    while ((htmlMatch = htmlInnerTextRegex.exec(content)) !== null) {
      const innerText = htmlMatch[1];
      const htmlIndex = htmlMatch.index;
      const innerTextStart = htmlIndex + htmlMatch[0].indexOf(innerText);
      const absoluteStart = variableStart + innerTextStart + offset;
      const absoluteEnd = absoluteStart + innerText.length;

      koreanRanges.push({
        start: absoluteStart,
        end: absoluteEnd,
        text: innerText,
      });
    }
    return koreanRanges;
  }

  private extractVariablesFromHtmlTemplate(
    processedText: string,
    positionMap: number[],
    excludeRanges: { start: number; end: number }[] = [],
    fileType: FileType,
  ): { variableRanges: TextRange[]; extractedRanges: TextRange[] } {
    const variableRanges: TextRange[] = [];
    const extractedRanges: TextRange[] = [];

    if (fileType === 'vue') {
      // Vue: {{}} 패턴 찾기
      const vueRegex = /\{\{(.*?)\}\}/g;
      let match: RegExpExecArray | null;
      while ((match = vueRegex.exec(processedText)) !== null) {
        const isInExcludeRange = excludeRanges.some(
          (range) => match!.index! >= range.start && match!.index! < range.end,
        );

        if (!isInExcludeRange && /[가-힣]/.test(match[1])) {
          const content = match[1];
          const variableStart = match.index!; // processedText 내의 위치
          const extracted = this.extractKoreanFromVariableContent(content, positionMap[variableStart], 2);
          const variableEnd = match.index! + match[0].length; // processedText 내의 위치

          extractedRanges.push(...extracted);
          variableRanges.push({
            start: positionMap[variableStart],
            end: positionMap[variableEnd - 1] + 1,
            text: match[0],
          });
        }
      }

      // Vue: "{}" 패턴 찾기 (줄바꿈/공백 포함)
      const vueQuotedRegex = /"[\s\n\r]*\{([^}]+)\}[\s\n\r]*"/g;
      while ((match = vueQuotedRegex.exec(processedText)) !== null) {
        const isInExcludeRange = excludeRanges.some(
          (range) => match!.index! >= range.start && match!.index! < range.end,
        );

        if (!isInExcludeRange && /[가-힣]/.test(match[1])) {
          const content = match[1];
          const variableStart = match.index!; // processedText 내의 위치
          const extracted = this.extractKoreanFromVariableContent(content, positionMap[variableStart], 2);
          const variableEnd = match.index! + match[0].length; // processedText 내의 위치

          extractedRanges.push(...extracted);
          variableRanges.push({
            start: positionMap[variableStart],
            end: positionMap[variableEnd - 1] + 1,
            text: match[0],
          });
        }
      }
    } else if (fileType === 'tsx') {
      // TSX: {``} 패턴 찾기
      const tsxRegex = /\{`([^`]*[가-힣][^`]*)`\}/g;
      let match: RegExpExecArray | null;
      while ((match = tsxRegex.exec(processedText)) !== null) {
        const isInExcludeRange = excludeRanges.some(
          (range) => match!.index! >= range.start && match!.index! < range.end,
        );

        if (!isInExcludeRange) {
          const content = '`' + match[1] + '`'; // 백틱까지 포함한 전체 내용
          const variableStart = match.index!; // processedText 내의 위치
          const extracted = this.extractKoreanFromVariableContent(content, positionMap[variableStart], 1);
          const variableEnd = match.index! + match[0].length; // processedText 내의 위치

          extractedRanges.push(...extracted);
          variableRanges.push({
            start: positionMap[variableStart],
            end: positionMap[variableEnd - 1] + 1,
            text: match[0],
          });
        }
      }
    }

    return { variableRanges, extractedRanges };
  }

  // HTML 템플릿에서 한글 텍스트 추출
  private extractKoreanFromHtmlTemplate(
    processedText: string,
    positionMap: number[],
    excludeRanges: { start: number; end: number }[] = [], // 제외할 범위들
    fileType: FileType,
  ): TextRange[] {
    const koreanRanges: TextRange[] = [];

    const richRanges = this.findInlineRichTextRanges(processedText, positionMap, excludeRanges);
    const overlapsRichText = (range: TextRange) =>
      richRanges.some((rich) => range.start < rich.end && range.end > rich.start);

    const { variableRanges, extractedRanges } = this.extractVariablesFromHtmlTemplate(
      processedText,
      positionMap,
      excludeRanges,
      fileType,
    );
    koreanRanges.push(...extractedRanges.filter((range) => !overlapsRichText(range)));

    // Vue 파일인 경우 배열 리터럴에서 한글 문자열 추출
    if (fileType === 'vue') {
      const arrayLiteralRanges = this.extractKoreanFromVueArrayLiterals(processedText, positionMap, excludeRanges);
      koreanRanges.push(...arrayLiteralRanges.filter((range) => !overlapsRichText(range)));
    }

    // 문자별 처리 로직
    const characterProcessedRanges = this.processTextCharacterByCharacter(
      processedText,
      positionMap,
      excludeRanges,
      fileType,
    );

    // variableRanges 기준으로 characterProcessedRanges 쪼개기
    const splitRanges = this.splitByVariables(
      characterProcessedRanges.filter((range) => !overlapsRichText(range)),
      variableRanges,
    );
    koreanRanges.push(...richRanges, ...splitRanges);

    return koreanRanges;
  }

  // 인라인 태그로 끊긴 문장을 태그까지 포함해 한 덩어리로 묶는다.
  private findInlineRichTextRanges(
    processedText: string,
    positionMap: number[],
    excludeRanges: { start: number; end: number }[],
  ): TextRange[] {
    const root = this.parseTemplate(processedText, excludeRanges);
    const ranges: TextRange[] = [];
    this.collectRichTextRanges(root, processedText, positionMap, ranges);
    return ranges;
  }

  private collectRichTextRanges(
    element: TemplateNode,
    text: string,
    positionMap: number[],
    ranges: TextRange[],
  ): void {
    if (element.type !== 'element' || element.kind === 'skip' || element.kind === 'inline') {
      return;
    }

    this.emitPhrasingSegments(element, text, positionMap, ranges);

    for (const child of element.children) {
      if (child.type === 'element') {
        this.collectRichTextRanges(child, text, positionMap, ranges);
      }
    }
  }

  private emitPhrasingSegments(
    element: TemplateNode,
    text: string,
    positionMap: number[],
    ranges: TextRange[],
  ): void {
    let segment: TemplateNode[] = [];
    const flush = () => {
      if (this.countKoreanTextNodes(segment, text) >= 2) {
        const collapseWhitespace = element.name !== 'pre' && element.name !== 'textarea';
        this.pushTrimmedRange(
          text,
          positionMap,
          segment[0].start,
          segment[segment.length - 1].end,
          ranges,
          collapseWhitespace,
        );
      }
      segment = [];
    };

    for (const child of element.children) {
      if (child.type === 'element' && child.kind !== 'inline') {
        flush();
        continue;
      }
      segment.push(child);
    }
    flush();
  }

  private countKoreanTextNodes(nodes: TemplateNode[], text: string): number {
    let count = 0;
    const walk = (node: TemplateNode) => {
      if (node.type === 'text') {
        if (/[가-힣]/.test(text.slice(node.start, node.end))) {
          count++;
        }
        return;
      }
      if (node.kind !== 'inline') {
        return;
      }
      node.children.forEach(walk);
    };
    nodes.forEach(walk);
    return count;
  }

  private pushTrimmedRange(
    text: string,
    positionMap: number[],
    start: number,
    end: number,
    ranges: TextRange[],
    collapseWhitespace = true,
  ): void {
    const raw = text.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const trimmedStart = start + leading;
    const trimmedEnd = end - trailing;
    if (trimmedEnd <= trimmedStart) {
      return;
    }
    if (positionMap[trimmedStart] === undefined || positionMap[trimmedEnd - 1] === undefined) {
      return;
    }

    const slice = text.slice(trimmedStart, trimmedEnd);
    const normalized = collapseWhitespace ? this.collapseFormattingWhitespace(slice) : slice;
    if (!/[가-힣]/.test(normalized)) {
      return;
    }

    ranges.push({
      start: positionMap[trimmedStart],
      end: positionMap[trimmedEnd - 1] + 1,
      text: normalized,
    });
  }

  // 소스 줄바꿈과 들여쓰기는 화면에서 공백 한 칸이다.
  private collapseFormattingWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  private keepsSourceWhitespace(text: string, gtIndex: number): boolean {
    const match = text.slice(0, gtIndex).match(/<([A-Za-z][\w:-]*)[^<]*$/);
    const tagName = match?.[1]?.toLowerCase();
    return tagName === 'pre' || tagName === 'textarea';
  }

  private parseTemplate(text: string, excludeRanges: { start: number; end: number }[]): TemplateNode {
    const root: TemplateNode = {
      type: 'element',
      start: 0,
      end: text.length,
      name: '#root',
      kind: 'block',
      openEnd: 0,
      closeStart: text.length,
      children: [],
    };
    const stack: TemplateNode[] = [root];
    let cursor = 0;
    let index = 0;

    const appendText = (from: number, to: number) => {
      if (to <= from) {
        return;
      }
      stack[stack.length - 1].children.push({
        type: 'text',
        start: from,
        end: to,
        children: [],
      });
    };

    while (index < text.length) {
      const excluded = excludeRanges.find((range) => index >= range.start && index < range.end);
      if (excluded) {
        appendText(cursor, excluded.start);
        cursor = excluded.end;
        index = excluded.end;
        continue;
      }

      if (text[index] !== '<') {
        index++;
        continue;
      }

      const tag = this.readHtmlTag(text, index);
      if (!tag) {
        index++;
        continue;
      }

      appendText(cursor, tag.start);

      if (tag.closing) {
        let matched = -1;
        for (let depth = stack.length - 1; depth >= 1; depth--) {
          if (stack[depth].name === tag.name) {
            matched = depth;
            break;
          }
        }
        if (matched !== -1) {
          while (stack.length - 1 > matched) {
            const unclosed = stack.pop()!;
            unclosed.closeStart = tag.start;
            unclosed.end = tag.start;
          }
          const element = stack.pop()!;
          element.closeStart = tag.start;
          element.end = tag.end;
        }
        cursor = tag.end;
        index = tag.end;
        continue;
      }

      const element: TemplateNode = {
        type: 'element',
        start: tag.start,
        end: tag.end,
        name: tag.name,
        kind: this.tagKind(tag.name),
        openEnd: tag.end,
        closeStart: tag.end,
        children: [],
      };
      stack[stack.length - 1].children.push(element);

      if (element.kind === 'skip' && !tag.selfClosing) {
        const closeMatch = text.slice(tag.end).match(new RegExp(`</${tag.name}\\s*>`, 'i'));
        if (closeMatch && closeMatch.index !== undefined) {
          element.closeStart = tag.end + closeMatch.index;
          element.end = element.closeStart + closeMatch[0].length;
        }
        cursor = element.end;
        index = element.end;
        continue;
      }

      if (!tag.selfClosing) {
        stack.push(element);
      }
      cursor = tag.end;
      index = tag.end;
    }

    appendText(cursor, text.length);
    while (stack.length > 1) {
      const unclosed = stack.pop()!;
      unclosed.closeStart = text.length;
      unclosed.end = text.length;
    }
    return root;
  }

  private tagKind(name: string): InlineTagKind {
    if (name === 'script' || name === 'style') {
      return 'skip';
    }
    if (name === '' || BLOCK_TAGS.has(name)) {
      return 'block';
    }
    if (INLINE_TAGS.has(name)) {
      return 'inline';
    }
    return 'other';
  }

  private readHtmlTag(text: string, index: number): TemplateTag | null {
    if (text[index] !== '<') {
      return null;
    }

    let cursor = index + 1;
    if (text[cursor] === '!' || text[cursor] === '?') {
      return null;
    }

    let closing = false;
    if (text[cursor] === '/') {
      closing = true;
      cursor++;
    }

    if (text[cursor] === '>') {
      return { start: index, end: cursor + 1, name: '', closing, selfClosing: false };
    }

    if (!/[A-Za-z]/.test(text[cursor] ?? '')) {
      return null;
    }

    const nameStart = cursor;
    while (cursor < text.length && /[A-Za-z0-9:_-]/.test(text[cursor])) {
      cursor++;
    }
    const name = text.slice(nameStart, cursor).toLowerCase();

    let quote: '"' | "'" | '`' | null = null;
    let braceDepth = 0;
    let selfClosing = false;
    while (cursor < text.length) {
      const char = text[cursor];
      if (quote) {
        if (char === '\\') {
          cursor += 2;
          continue;
        }
        if (char === quote) {
          quote = null;
        }
        cursor++;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        cursor++;
        continue;
      }
      if (char === '{') {
        braceDepth++;
        cursor++;
        continue;
      }
      if (char === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        cursor++;
        continue;
      }
      if (char === '/' && text[cursor + 1] === '>' && braceDepth === 0) {
        selfClosing = true;
        cursor += 2;
        break;
      }
      if (char === '>' && braceDepth === 0) {
        cursor++;
        break;
      }
      cursor++;
    }

    if (VOID_TAGS.has(name)) {
      selfClosing = true;
    }

    return { start: index, end: cursor, name, closing, selfClosing };
  }

  private splitByVariables(koreanRanges: TextRange[], variableRanges: TextRange[]): TextRange[] {
    const result: TextRange[] = [];

    for (const koreanRange of koreanRanges) {
      // 이 범위 안에 완전히 포함된 variableRanges 찾기
      const insideVariables = variableRanges.filter((vr) => vr.start >= koreanRange.start && vr.end <= koreanRange.end);
      if (insideVariables.length === 0) {
        // 변수가 없으면 그대로 추가
        result.push(koreanRange);
        continue;
      }

      // 변수 기준으로 쪼개기
      let currentStart = koreanRange.start;

      for (const variable of insideVariables) {
        // 변수 앞의 텍스트
        if (currentStart < variable.start) {
          const beforeText = koreanRange.text.substring(
            currentStart - koreanRange.start,
            variable.start - koreanRange.start,
          );
          if (beforeText && /[가-힣]/.test(beforeText)) {
            result.push({
              start: currentStart,
              end: variable.start,
              text: beforeText,
            });
          }
        }
        currentStart = variable.end;
      }

      // 마지막 변수 뒤의 텍스트
      if (currentStart < koreanRange.end) {
        const afterText = koreanRange.text.substring(
          currentStart - koreanRange.start,
          koreanRange.end - koreanRange.start,
        );
        if (afterText && /[가-힣]/.test(afterText)) {
          result.push({
            start: currentStart,
            end: koreanRange.end,
            text: afterText,
          });
        }
      }
    }

    return result;
  }

  // 텍스트를 문자별로 처리하여 한글 텍스트 추출
  private processTextCharacterByCharacter(
    processedText: string,
    positionMap: number[],
    excludeRanges: { start: number; end: number }[] = [],
    fileType: FileType,
  ): TextRange[] {
    const koreanRanges: TextRange[] = [];

    let currentWord = '';
    let currentStart = -1;
    let hasKorean = false;
    let inString = false;
    let stringType: '"' | "'" | '`' | '>' | null = null;

    for (let i = 0; i < processedText.length; i++) {
      // 제외할 범위 내부인지 확인
      const isInExcludeRange = excludeRanges.some((range) => i >= range.start && i < range.end);
      if (isInExcludeRange) {
        continue;
      }

      const char = processedText[i];

      // Vue "{}" 패턴 감지하여 건너뛰기
      if (fileType === 'vue' && char === '"') {
        // 현재 위치부터 "{}" 패턴 찾기
        const remainingText = processedText.substring(i);
        const vueQuotedMatch = remainingText.match(/^"[\s\n\r]*\{[^}]*\}[\s\n\r]*"/);
        if (vueQuotedMatch) {
          i += vueQuotedMatch[0].length - 1; // 패턴 길이만큼 건너뛰기
          continue;
        }

        // Vue 배열 리터럴 패턴도 건너뛰기
        const vueArrayMatch = remainingText.match(/^"\[[^\]]*\]"/);
        if (vueArrayMatch) {
          i += vueArrayMatch[0].length - 1; // 패턴 길이만큼 건너뛰기
          continue;
        }
      }

      // 문자열 시작 트리거 확인
      if (!inString && (char === '"' || char === "'" || char === '`' || char === '>')) {
        // => 패턴인지 확인 (화살표 함수)
        if (char === '>' && i > 0 && processedText[i - 1] === '=') {
          // => 패턴이면 문자열 시작 트리거로 인식하지 않음
          continue;
        }

        // 이전에 한글이 있었다면 저장
        if (currentWord.trim().length > 0 && hasKorean) {
          this.saveCurrentWord(currentWord, currentStart, i, positionMap, koreanRanges);
          currentWord = '';
          currentStart = -1;
          hasKorean = false;
        }

        // 문자열 시작
        inString = true;
        stringType = char as '"' | "'" | '`' | '>';
        currentStart = i;
        currentWord = char;
        continue;
      }

      // 문자열 닫힘 트리거 확인
      if (inString) {
        if (this.isStringClosing(char, stringType)) {
          currentWord += char;

          // 문자열 안에 한글이 있었는지 확인
          if (hasKorean) {
            this.saveStringContent(
              currentWord,
              currentStart,
              stringType,
              positionMap,
              koreanRanges,
              fileType,
              processedText,
            );
          }

          // 문자열 종료
          inString = false;
          stringType = null;
          currentWord = '';
          currentStart = -1;
          hasKorean = false;
          continue;
        }
      }

      // 문자열 안에 있으면 모든 문자 추가
      if (inString) {
        currentWord += char;
        if (/[가-힣]/.test(char)) {
          hasKorean = true;
        }
        continue;
      }

      // 문자열 밖에서의 일반 처리
      this.processCharacterOutsideString(char, currentWord, currentStart, hasKorean, i, positionMap, koreanRanges);
    }

    // 마지막 단어 처리
    if (currentWord.trim().length > 0 && hasKorean) {
      this.saveCurrentWord(currentWord, currentStart, processedText.length, positionMap, koreanRanges);
    }

    return koreanRanges;
  }

  // 문자열 닫힘 확인
  private isStringClosing(char: string, stringType: string | null): boolean {
    return (
      (stringType === '"' && char === '"') ||
      (stringType === "'" && char === "'") ||
      (stringType === '`' && char === '`') ||
      (stringType === '>' && char === '<')
    );
  }

  // 현재 단어 저장
  private saveCurrentWord(
    currentWord: string,
    currentStart: number,
    currentIndex: number,
    positionMap: number[],
    koreanRanges: TextRange[],
  ): void {
    const trimmedWord = currentWord.replace(/^\s+|\s+$/g, '');
    const actualStart = currentStart + (currentWord.length - currentWord.trimStart().length);
    const actualEnd = currentIndex - (currentWord.length - currentWord.trimEnd().length);

    const originalStart = positionMap[actualStart];
    const originalEnd = positionMap[actualEnd - 1] + 1;

    if (trimmedWord) {
      koreanRanges.push({
        start: originalStart,
        end: originalEnd,
        text: trimmedWord,
      });
    }
  }

  // 문자열 내용 저장
  private saveStringContent(
    currentWord: string,
    currentStart: number,
    stringType: string | null,
    positionMap: number[],
    koreanRanges: TextRange[],
    fileType: FileType,
    processedText: string,
  ): void {
    // 따옴표는 제외하고 내용만 추출
    let content = removeQuotes(currentWord.trim());

    if (content) {
      if (stringType === '>') {
        let fullContent = currentWord.slice(1, -1);

        // Vue 파일의 {{`...`}} 패턴 처리
        const vueTemplateRegex = /^\s*\{\{\s*`([\s\S]*)`\s*\}\}\s*$/;
        // TSX 파일의 {`...`} 패턴 처리
        const tsxTemplateRegex = /^\s*\{\s*`([\s\S]*)`\s*\}\s*$/;

        let templateOffset = 0; // 템플릿 패턴으로 인한 오프셋
        let extractedContent = fullContent;

        if (fileType === 'vue') {
          const vueMatch = fullContent.match(vueTemplateRegex);
          if (vueMatch) {
            extractedContent = vueMatch[1];
            templateOffset = fullContent.indexOf('`') + 1;
          }
        } else if (fileType === 'tsx') {
          const tsxMatch = fullContent.match(tsxTemplateRegex);
          if (tsxMatch) {
            extractedContent = tsxMatch[1];
            templateOffset = fullContent.indexOf('`') + 1;
          }
        }
        const trimmedStart = extractedContent.length - extractedContent.trimStart().length;
        const trimmedEnd = extractedContent.trimEnd().length;

        const textStart = currentStart + 1 + templateOffset + trimmedStart;
        const textEnd = currentStart + 1 + templateOffset + trimmedEnd;
        const textOriginalStart = positionMap[textStart];
        const textOriginalEnd = positionMap[textEnd - 1] + 1;
        const keepWhitespace = templateOffset > 0 || this.keepsSourceWhitespace(processedText, currentStart);
        const normalizedText = keepWhitespace
          ? extractedContent.trim()
          : this.collapseFormattingWhitespace(extractedContent);

        if (!normalizedText) {
          return;
        }

        koreanRanges.push({
          start: textOriginalStart,
          end: textOriginalEnd,
          text: normalizedText,
        });
      } else {
        const textStart = currentStart + 1;
        const textEnd = currentStart + 1 + content.length;
        const textOriginalStart = positionMap[textStart];
        const textOriginalEnd = positionMap[textEnd - 1] + 1;

        koreanRanges.push({
          start: textOriginalStart,
          end: textOriginalEnd,
          text: content,
        });
      }
    }
  }

  // 문자열 밖에서의 문자 처리
  private processCharacterOutsideString(
    char: string,
    currentWord: string,
    currentStart: number,
    hasKorean: boolean,
    currentIndex: number,
    positionMap: number[],
    koreanRanges: TextRange[],
  ): void {
    // 한글이면 현재 단어에 추가
    if (/[가-힣]/.test(char)) {
      if (currentStart === -1) {
        currentStart = currentIndex;
      }
      currentWord += char;
      hasKorean = true;
    }
    // 공백이면 현재 단어에 추가 (단어 내부 공백)
    else if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (currentWord.length > 0) {
        currentWord += char;
      }
    }
    // 괄호나 특수문자 중에서 한글과 함께 사용되는 것들
    else if (/[()[\]{}_-]/.test(char)) {
      if (currentWord.length > 0 && hasKorean) {
        currentWord += char;
      }
    }
    // 한글이 아닌 다른 문자를 만나면
    else {
      // 현재 단어가 있고 한글이 포함되어 있으면 저장
      if (currentWord.trim().length > 0 && hasKorean) {
        this.saveCurrentWord(currentWord, currentStart, currentIndex, positionMap, koreanRanges);
        currentWord = '';
        currentStart = -1;
        hasKorean = false;
      }
    }
  }

  // TSX 파일에서 한글 찾기 (위치 매핑 포함)
  private findKoreanInTsxFileWithMapping(processedText: string, positionMap: number[]): TextRange[] {
    const koreanRanges: TextRange[] = [];

    // 1. JSX 태그 범위 찾기
    const jsxTagRanges = this.findJsxTagRanges(processedText);

    // 2. JSX 태그 내부의 텍스트 처리
    const jsxTextRanges = this.extractKoreanFromJsxTags(processedText, positionMap);
    koreanRanges.push(...jsxTextRanges);

    // 3. TypeScript 코드 부분 처리 (JSX 태그 외부)
    const tsKoreanRanges = this.findKoreanInTsFileWithMapping(processedText, positionMap, jsxTagRanges);

    koreanRanges.push(...tsKoreanRanges);
    return koreanRanges;
  }

  // JSX 태그의 전체 범위 찾기
  private findJsxTagRanges(processedText: string): { start: number; end: number }[] {
    const ranges: { start: number; end: number }[] = [];
    const jsxTagRegex = /<[A-Za-z][A-Za-z0-9]*(?:\s+[^>]*)?>/g;
    let match;

    while ((match = jsxTagRegex.exec(processedText)) !== null) {
      const start = match.index;
      // 닫는 태그 찾기
      const tagName = match[0].match(/<([A-Za-z][A-Za-z0-9]*)/)?.[1];
      if (tagName) {
        const closingTagRegex = new RegExp(`</${tagName}>`, 'g');
        closingTagRegex.lastIndex = match.index + match[0].length;
        const closingMatch = closingTagRegex.exec(processedText);
        if (closingMatch) {
          ranges.push({
            start: start,
            end: closingMatch.index + closingMatch[0].length,
          });
        }
      }
    }

    return ranges;
  }

  // JSX 태그에서 한글 텍스트 추출
  private extractKoreanFromJsxTags(processedText: string, positionMap: number[]): TextRange[] {
    const koreanRanges: TextRange[] = [];

    // 1. return () 블록 찾기
    const returnBlocks = this.findReturnBlocks(processedText);

    for (const returnBlock of returnBlocks) {
      const returnContent = processedText.substring(returnBlock.start, returnBlock.end);
      const returnPositionMap = positionMap.slice(returnBlock.start, returnBlock.end);

      // return 블록 내에서만 JSX 태그 처리
      const jsxRanges = this.extractKoreanFromHtmlTemplate(returnContent, returnPositionMap, [], 'tsx');
      koreanRanges.push(...jsxRanges);
    }

    return koreanRanges;
  }

  // return () 블록 찾기
  private findReturnBlocks(text: string): { start: number; end: number }[] {
    const returnBlocks: { start: number; end: number }[] = [];
    const returnRegex = /\breturn\s*\(/g;
    let match;

    while ((match = returnRegex.exec(text)) !== null) {
      const returnStart = match.index!;

      // 매칭되는 ')' 찾기
      const returnEnd = this.findMatchingBracket(text, returnStart + match[0].length - 1, '(', ')');

      if (returnEnd !== -1) {
        returnBlocks.push({
          start: returnStart,
          end: returnEnd + 1,
        });
      }
    }

    return returnBlocks;
  }

  // Vue 템플릿에서 배열 리터럴 내부의 한글 문자열 추출
  private extractKoreanFromVueArrayLiterals(
    processedText: string,
    positionMap: number[],
    excludeRanges: { start: number; end: number }[] = [],
  ): TextRange[] {
    const koreanRanges: TextRange[] = [];

    // Vue 속성에서 배열 리터럴 패턴 찾기
    const arrayLiteralRegex = /:[\w-]+="\[([^\]]*)\]"/g;
    let match: RegExpExecArray | null;

    while ((match = arrayLiteralRegex.exec(processedText)) !== null) {
      const arrayContent = match[1];
      const arrayStart = match.index + match[0].indexOf('[') + 1; // [ 다음부터

      // 제외 범위 내부인지 확인
      const isInExcludeRange = excludeRanges.some((range) => match!.index >= range.start && match!.index < range.end);
      if (isInExcludeRange) {
        continue;
      }

      // 배열 내부의 개별 문자열 추출
      const stringRegex = /(['"`])([^'"`]*[가-힣][^'"`]*)\1/g;
      let stringMatch: RegExpExecArray | null;

      while ((stringMatch = stringRegex.exec(arrayContent)) !== null) {
        const quoteType = stringMatch[1];
        const stringContent = stringMatch[2];
        const stringStart = arrayStart + stringMatch.index;
        const stringEnd = stringStart + stringMatch[0].length;

        // 원본 텍스트에서 해당 위치 찾기
        const originalStart = positionMap[stringStart];
        const originalEnd = positionMap[stringEnd];

        koreanRanges.push({
          start: originalStart,
          end: originalEnd,
          text: quoteType + stringContent + quoteType,
        });
      }
    }

    return koreanRanges;
  }

  // 메인 추출 함수
  public extractKoreanTexts(text: string, fileName: string): ExtractedTexts {
    // 파일 타입 확인
    let fileType = '';
    if (fileName.toLowerCase().endsWith('.vue')) {
      fileType = 'vue';
    } else if (fileName.toLowerCase().endsWith('.ts') || fileName.toLowerCase().endsWith('.js')) {
      fileType = 'ts';
    } else if (fileName.toLowerCase().endsWith('.tsx') || fileName.toLowerCase().endsWith('.jsx')) {
      fileType = 'tsx';
    }

    if (!['vue', 'ts', 'tsx'].includes(fileType)) {
      return { koreanRanges: [], i18nRanges: [] };
    }

    // 주석 제거하면서 위치 매핑 정보 생성
    const { processedText, positionMap } = this.removeCommentsWithMapping(text);

    // 1. 모든 한글 텍스트 찾기 (i18n 체크 없이)
    let allKoreanRanges: TextRange[] = [];
    switch (fileType) {
      case 'vue':
        allKoreanRanges = this.findKoreanInVueFileWithMapping(processedText, positionMap);
        break;
      case 'ts':
        allKoreanRanges = this.findKoreanInTsFileWithMapping(processedText, positionMap);
        break;
      case 'tsx':
        allKoreanRanges = this.findKoreanInTsxFileWithMapping(processedText, positionMap);
        break;
    }

    // 2. i18n 적용된 부분 찾기 (원본 텍스트 기준)
    const i18nRanges = this.findI18nRanges(text);

    // 3. 한글 텍스트에서 i18n 범위와 겹치는 부분 제거
    const koreanRanges = allKoreanRanges.filter((koreanRange) => {
      // i18n 범위와 겹치는지 확인
      const overlapsWithI18n = i18nRanges.some((i18nRange) => {
        // 겹치는 조건: 한글 범위가 i18n 범위와 교차하거나 포함되는 경우
        return koreanRange.start < i18nRange.end && koreanRange.end > i18nRange.start;
      });

      // 겹치지 않는 경우만 유지
      return !overlapsWithI18n;
    });

    return { koreanRanges, i18nRanges };
  }
}

const service = new KoreanExtractionService();

export const extractKoreanTexts = service.extractKoreanTexts.bind(service);
