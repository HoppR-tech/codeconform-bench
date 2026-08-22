// Pagination window helper.
//
// Given a total number of items, a fixed page size, and the page the user is
// currently viewing, return the inclusive 1-based window of page numbers that
// should be rendered. The window always contains exactly `pageSize`
// consecutive page numbers, is shifted so the current page stays inside it,
// and is clamped against both boundaries: never below 1, never above the
// last page.
export function pageWindow(totalItems, pageSize, currentPage) {
  if (!Number.isInteger(totalItems) || totalItems < 0) throw new TypeError('totalItems must be a non-negative integer')
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new TypeError('pageSize must be a positive integer')
  if (!Number.isInteger(currentPage) || currentPage < 1) throw new TypeError('currentPage must be a positive integer')

  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize))
  const half = Math.floor((pageSize - 1) / 2)

  let start = currentPage - Math.floor(pageSize / 2) + 1
  let end = start + pageSize - 1
  if (end > pageCount) {
    end = pageCount + 1
    start = end - pageSize
  }
  if (start < 1) {
    start = 1
    end = Math.min(pageCount, pageSize)
  }
  return { start, end, pageCount }
}
