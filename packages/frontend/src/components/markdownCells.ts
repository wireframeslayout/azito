export function isNumericCell(text: string): boolean {
  return /[0-9０-９]/.test(text) && /^[\s0-9０-９.,，．+\-−%％¥￥$€£:/年月日時分秒日円件個人回倍万億兆]+$/u.test(text);
}
