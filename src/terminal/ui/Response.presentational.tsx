import type { ReactElement, ReactNode } from 'react';
import { Box, Text } from 'ink';
import { ChatResponsePartType } from '../../chat/ChatResponsePartType.ts';
import { ToolActivity } from './ToolActivity.presentational.tsx';
import type { ResponseState } from './useResponseState.ts';

export interface ResponseProps extends ResponseState {
  footer?: ReactNode;
}

export function Response({ sections, footer }: ResponseProps): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      {sections.map((section, index) => {
        const { type } = section;
        switch (type) {
          case ChatResponsePartType.TEXT: {
            const { value } = section;
            return (
              <Text key={index} color="green">
                <Text bold>{'assistant> '}</Text>
                {value}
              </Text>
            );
          }
          case ChatResponsePartType.REASONING_SUMMARY: {
            const { value } = section;
            return (
              <Text key={index} dimColor>
                <Text bold>{'thinking> '}</Text>
                {value}
              </Text>
            );
          }
          case ChatResponsePartType.DIAGNOSTIC: {
            const { message } = section;
            return (
              <Text key={index} bold color="red">
                {message}
              </Text>
            );
          }
          case ChatResponsePartType.TOOL: {
            const { activity } = section;
            return <ToolActivity key={index} activity={activity} />;
          }
        }
      })}
      {footer}
    </Box>
  );
}
