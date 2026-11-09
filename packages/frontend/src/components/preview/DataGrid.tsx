import type { KeyboardEvent } from 'react';

interface Props {
  rows: string[][];
  rowOffset: number;
  columns: number;
  disabled: boolean;
  onSelect: (row: number, column: number) => void;
  onChange: (row: number, column: number, value: string) => void;
}
export function DataGrid({ rows, rowOffset, columns, disabled, onSelect, onChange }: Props) {
  const move = (event: KeyboardEvent<HTMLInputElement>, row: number, column: number) => {
    const delta = event.key === 'ArrowDown' || event.key === 'Enter' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    const target = event.currentTarget.closest('table')?.querySelector<HTMLInputElement>(`input[data-row="${row + delta}"][data-column="${column}"]`);
    if (target) { event.preventDefault(); target.focus(); }
  };
  return <div style={{ overflow: 'auto', maxHeight: '60vh' }}><table><tbody>{rows.map((row, index) => {
    const rowNumber = rowOffset + index;
    return <tr key={rowNumber}><th scope="row">{rowNumber + 1}</th>{Array.from({ length: columns }, (_, col) => <td key={col}><input data-row={rowNumber} data-column={col} aria-label={`${rowNumber + 1}, ${col + 1}`} value={row[col] || ''} disabled={disabled} onFocus={() => onSelect(rowNumber, col)} onKeyDown={(event) => move(event, rowNumber, col)} onChange={(event) => onChange(rowNumber, col, event.target.value)} /></td>)}</tr>;
  })}</tbody></table></div>;
}
