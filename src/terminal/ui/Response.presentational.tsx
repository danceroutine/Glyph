import type { ReactElement, ReactNode } from 'react';
import { Box, Text } from 'ink';
import { ChatResponsePartType } from '../../chat/ChatResponsePartType.ts';
import { ToolActivityPresentational } from './ToolActivity.presentational.tsx';
import type { ResponseState } from './useResponseState.ts';

export interface ResponsePresentationalProps extends ResponseState {
  footer?: ReactNode;
}

export function ResponsePresentational({ sections, footer }: ResponsePresentationalProps): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      {sections.map((section, index) => {
        switch (section.type) {
          case ChatResponsePartType.TEXT:
            return (
              <Text key={index} color="green">
                <Text bold>{'assistant> '}</Text>
                {section.value}
              </Text>
            );
          case ChatResponsePartType.REASONING_SUMMARY:
            return (
              <Text key={index} dimColor>
                <Text bold>{'thinking> '}</Text>
                {section.value}
              </Text>
            );
          case ChatResponsePartType.DIAGNOSTIC:
            return (
              <Text key={index} bold color="red">
                {section.message}
              </Text>
            );
          case ChatResponsePartType.TOOL:
            return <ToolActivityPresentational key={index} activity={section.activity} />;
        }
      })}
      {footer}
    </Box>
  );
}
