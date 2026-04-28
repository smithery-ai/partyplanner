"use client";

import type { CSSProperties } from "react";
import { useMemo } from "react";

import {
  type DotAnimationResolver,
  DotMatrixBase,
  type DotMatrixCommonProps,
} from "../../lib/dotmatrix-core";
import {
  useDotMatrixPhases,
  usePrefersReducedMotion,
  useSteppedCycle,
} from "../../lib/dotmatrix-hooks";

export interface DotmSquare1Props extends DotMatrixCommonProps {
  letters?: string;
  showHeart?: boolean;
}

const LETTER_REVEAL_STEPS = 25;
const LETTER_HOLD_STEPS = 12;
const LETTER_STEPS = LETTER_REVEAL_STEPS + LETTER_HOLD_STEPS;
const LETTER_CYCLE_MS = 1350;

const LETTER_ROWS: Record<string, readonly string[]> = {
  A: ["01110", "10001", "11111", "10001", "10001"],
  B: ["11110", "10001", "11110", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "11110", "10000", "11111"],
  F: ["11111", "10000", "11110", "10000", "10000"],
  G: ["01111", "10000", "10111", "10001", "01111"],
  H: ["10001", "10001", "11111", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "11100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001"],
  O: ["01110", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "11110", "10000", "10000"],
  Q: ["01110", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "11110", "10010", "10001"],
  S: ["01111", "10000", "01110", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "01010", "01010", "00100"],
  W: ["10001", "10001", "10101", "11011", "10001"],
  X: ["10001", "01010", "00100", "01010", "10001"],
  Y: ["10001", "01010", "00100", "00100", "00100"],
  Z: ["11111", "00010", "00100", "01000", "11111"],
  "0": ["01110", "10011", "10101", "11001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00010", "00100", "11111"],
  "3": ["11110", "00001", "01110", "00001", "11110"],
  "4": ["10010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "11110"],
  "6": ["01111", "10000", "11110", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000"],
  "8": ["01110", "10001", "01110", "10001", "01110"],
  "9": ["01110", "10001", "01111", "00001", "11110"],
  "?": ["11110", "00001", "00110", "00000", "00100"],
  HEART: ["01010", "11111", "11111", "01110", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000"],
};

function letterIndexes(letter: string): Set<number> {
  const rows = LETTER_ROWS[letter] ?? LETTER_ROWS["?"];
  const indexes = new Set<number>();

  for (const [row, cols] of rows.entries()) {
    for (const [col, value] of Array.from(cols).entries()) {
      if (value === "1") {
        indexes.add(row * 5 + col);
      }
    }
  }

  return indexes;
}

function letterOrder(letter: string): number[] {
  return Array.from(letterIndexes(letter)).sort((a, b) => a - b);
}

function normalizeLetters(value: string): string[] {
  const normalized = Array.from(value.toUpperCase()).map((letter) =>
    LETTER_ROWS[letter] ? letter : "?",
  );

  return normalized.length > 0 ? normalized : ["?"];
}

export function DotmSquare1({
  speed = 1,
  pattern = "full",
  animated = true,
  hoverAnimated = false,
  letters = "SMITHERY",
  showHeart = true,
  ...rest
}: DotmSquare1Props) {
  const reducedMotion = usePrefersReducedMotion();
  const {
    phase: matrixPhase,
    onMouseEnter,
    onMouseLeave,
  } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed,
  });
  const glyphs = useMemo(
    () =>
      [...normalizeLetters(letters), ...(showHeart ? ["HEART"] : [])].map(
        (letter) => ({
          letter,
          indexes: letterIndexes(letter),
          order: letterOrder(letter),
        }),
      ),
    [letters, showHeart],
  );
  const sequenceStep = useSteppedCycle({
    active: Boolean(animated && !reducedMotion && glyphs.length > 0),
    cycleMsBase: glyphs.length * LETTER_CYCLE_MS,
    steps: glyphs.length * LETTER_STEPS,
    speed,
  });
  const letterIndex = Math.floor(sequenceStep / LETTER_STEPS) % glyphs.length;
  const letterStep = sequenceStep % LETTER_STEPS;
  const currentGlyph = glyphs[letterIndex] ?? glyphs[0];
  const revealCount =
    letterStep >= LETTER_REVEAL_STEPS
      ? currentGlyph.order.length
      : Math.min(letterStep + 1, currentGlyph.order.length);
  const scanHeadIndex = currentGlyph.order[revealCount - 1];
  const animationResolver = useMemo<DotAnimationResolver>(
    () =>
      ({ isActive, index, reducedMotion: reduceDotMotion, phase }) => {
        const isLetterDot = Boolean(
          isActive && currentGlyph?.indexes.has(index),
        );
        if (!isLetterDot) {
          return { className: "dmx-inactive" };
        }

        if (reduceDotMotion || phase === "idle") {
          return { style: { opacity: 0.94 } };
        }

        const dotOrder = currentGlyph.order.indexOf(index);
        const isRevealed = dotOrder >= 0 && dotOrder < revealCount;
        const isScanHead = index === scanHeadIndex;
        return {
          style: {
            opacity: isRevealed ? (isScanHead ? 1 : 0.86) : 0,
            transform: isRevealed ? "scale(1)" : "scale(0.45)",
            transition: "opacity 120ms ease-out, transform 120ms ease-out",
          } as CSSProperties,
        };
      },
    [currentGlyph, revealCount, scanHeadIndex],
  );

  return (
    <DotMatrixBase
      {...rest}
      size={rest.size ?? 36}
      dotSize={rest.dotSize ?? 5}
      speed={speed}
      pattern={pattern}
      animated={animated}
      phase={matrixPhase}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      reducedMotion={reducedMotion}
      animationResolver={animationResolver}
    />
  );
}
