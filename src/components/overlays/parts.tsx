import { chordKeys } from './chords';
import { highlightSegments } from './fuzzy';

export function Highlight({ text, positions }: { text: string; positions: readonly number[] }) {
  if (!positions.length) {
    return <>{text}</>;
  }
  return (
    <>
      {highlightSegments(text, positions).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="ov-hl">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** Canonical chord rendered as key caps. */
export function Chord({ chord }: { chord: string }) {
  return (
    <span className="ov-chord" aria-label={chordKeys(chord).join('+')}>
      {chordKeys(chord).map((key, index) => (
        <kbd key={index} className="kbd">
          {key}
        </kbd>
      ))}
    </span>
  );
}
