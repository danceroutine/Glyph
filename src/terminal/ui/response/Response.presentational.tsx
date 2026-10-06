import type { ReactElement, ReactNode } from 'react';
import { Box, Text } from 'ink';
import { ChatResponsePartType } from '../../../chat/ChatResponsePartType.ts';
import { parseInlineMarkdown } from './parseInlineMarkdown.ts';
import { ToolActivity } from './ToolActivity.presentational.tsx';
import type { ResponseState } from './useResponseState.ts';

export interface ResponseProps extends ResponseState {
  footer?: ReactNode;
}

export function Response({ sections, pendingFrame, toolFrame, messageWidth, footer }: ResponseProps): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      {pendingFrame === undefined ? null : <PendingResponse frame={pendingFrame} />}
      {sections.map((section, index) => {
        const { type } = section;
        switch (type) {
          case ChatResponsePartType.TEXT: {
            const { value } = section;
            return (
              <Box key={index} maxWidth={messageWidth}>
                <Box backgroundColor="gray" borderColor="gray" borderStyle="round" paddingX={2}>
                  <Text color="white">{value}</Text>
                </Box>
              </Box>
            );
          }
          case ChatResponsePartType.REASONING_SUMMARY: {
            const { value } = section;
            return (
              <Text key={index} dimColor>
                {'thinking> '}
                {parseInlineMarkdown(value).map((segment, segmentIndex) =>
                  segment.strong ? (
                    <Text key={segmentIndex} bold>
                      {segment.value}
                    </Text>
                  ) : (
                    segment.value
                  ),
                )}
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
            return (
              <ToolActivity
                key={index}
                activity={activity}
                {...(toolFrame === undefined ? {} : { frame: toolFrame })}
              />
            );
          }
        }
      })}
      {footer}
    </Box>
  );
}

const ORB_PATH = [0, 1, 2, 1] as const;

function PendingResponse({ frame }: { frame: number }): ReactElement {
  const activeOrb = ORB_PATH[frame % ORB_PATH.length];
  return (
    <Text dimColor>
      {'thinking> '}
      {[0, 1, 2].map(index => (
        <Text key={index} bold={index === activeOrb}>
          {`${index === activeOrb ? '●' : '·'}${index < 2 ? ' ' : ''}`}
        </Text>
      ))}
    </Text>
  );
}
