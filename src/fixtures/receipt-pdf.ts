/**
 * A real PDF, because a fake one proves nothing.
 *
 * 1.4 KB, one page, three lines of a grocery receipt. It is here rather than
 * generated at test time because generating a valid PDF needs a library, and
 * the whole point is to test the reader against a file produced by something
 * other than the reader.
 *
 * This exists because of a silent failure worth remembering: the original PDF
 * dependency bundled a pdf.js from 2016 and rejected any file using a
 * cross-reference stream, which is almost every PDF made in the last decade. It
 * did not crash or report a missing dependency. It recorded an unreadable
 * attachment and moved on, so a mailbox full of PDF receipts extracted nothing
 * and reported nothing wrong.
 */
export const RECEIPT_PDF_BASE64 =
  "JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3Vy" +
  "Y2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAv" +
  "SGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAv" +
  "VHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9N" +
  "ZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNiAwIFIgL1Jlc291cmNl" +
  "cyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9J" +
  "bWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRv" +
  "YmoKNCAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDYgMCBSIC9UeXBlIC9DYXRh" +
  "bG9nCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9BdXRob3IgKGFub255bW91cykgL0NyZWF0aW9uRGF0" +
  "ZSAoRDoyMDI2MDgxNDEzMjcwOSswMCcwMCcpIC9DcmVhdG9yIChhbm9ueW1vdXMpIC9LZXl3b3Jk" +
  "cyAoKSAvTW9kRGF0ZSAoRDoyMDI2MDgxNDEzMjcwOSswMCcwMCcpIC9Qcm9kdWNlciAoUmVwb3J0" +
  "TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0ICh1bnNwZWNpZmll" +
  "ZCkgL1RpdGxlICh1bnRpdGxlZCkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago2IDAgb2JqCjw8" +
  "Ci9Db3VudCAxIC9LaWRzIFsgMyAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjcgMCBvYmoK" +
  "PDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2RlIC9GbGF0ZURlY29kZSBdIC9MZW5ndGggMTY1Cj4+" +
  "CnN0cmVhbQpHYXJwIlltUz8lJ1NZTVo6W3NNMjpqWVBgRnFvKjM+VjgiZj1JW209NkxGWVtZUlYv" +
  "Y0pNUzprLVBTJCNEQkU7Ylg6S24ib1MyI1JVLj1wR1YtUThkQjVqPUFOQGBAdCc8Qyd1VnQhck89" +
  "UjBMU0czSjRIWipRMVcoT1RvcF1jTlAtZ1AiWUBrJTRAXFJbTkdOV2Q6bHIoXGAmIUhOQGFyL1U3" +
  "fj5lbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA2" +
  "MSAwMDAwMCBuIAowMDAwMDAwMDkyIDAwMDAwIG4gCjAwMDAwMDAxOTkgMDAwMDAgbiAKMDAwMDAw" +
  "MDQwMiAwMDAwMCBuIAowMDAwMDAwNDcwIDAwMDAwIG4gCjAwMDAwMDA3MzEgMDAwMDAgbiAKMDAw" +
  "MDAwMDc5MCAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9JRCAKWzw2OTM4NDg4MjAyNGJlYWYyOTkzZjRm" +
  "ODQxYjE1MjA3Zj48NjkzODQ4ODIwMjRiZWFmMjk5M2Y0Zjg0MWIxNTIwN2Y+XQolIFJlcG9ydExh" +
  "YiBnZW5lcmF0ZWQgUERGIGRvY3VtZW50IC0tIGRpZ2VzdCAob3BlbnNvdXJjZSkKCi9JbmZvIDUg" +
  "MCBSCi9Sb290IDQgMCBSCi9TaXplIDgKPj4Kc3RhcnR4cmVmCjEwNDUKJSVFT0YK";

export function receiptPdf(): Buffer {
  return Buffer.from(RECEIPT_PDF_BASE64, "base64");
}

/** What the reader must find in it. */
export const RECEIPT_PDF_CONTAINS: readonly string[] = ["Wegmans", "chicken thighs", "42.17"];
