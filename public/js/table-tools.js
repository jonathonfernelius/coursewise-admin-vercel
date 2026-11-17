// Search and sort the records already rendered by EJS; no extra database request is needed.
document.querySelectorAll("[data-table-tools]").forEach((tools) => {
  const table = tools.querySelector("[data-sortable-table]");
  const panel = tools.closest(".panel");
  const search = panel?.querySelector("[data-table-search]");
  if (!table) return;

  const body = table.querySelector("tbody");
  const rows = Array.from(body.querySelectorAll("[data-filter-row]"));
  const count = panel?.querySelector("[data-record-count]");
  const filterEmpty = tools.querySelector("[data-filter-empty]");
  const total = rows.length;
  let sortedColumn = null;
  let sortDirection = "asc";

  // Update visibility from the row's searchable values and keep the record count useful.
  function updateFilter() {
    const query = (search?.value || "").trim().toLocaleLowerCase();
    let visible = 0;
    rows.forEach((row) => {
      const searchableText = (row.dataset.search || row.textContent).toLocaleLowerCase();
      const matches = searchableText.includes(query);
      row.hidden = !matches;
      if (matches) visible += 1;
    });
    if (count) {
      const label = count.dataset.recordLabel || "records";
      const singular = count.dataset.recordSingular || label.replace(/s$/, "");
      const noun = total === 1 ? singular : label;
      count.textContent = query ? `Showing ${visible} of ${total} ${noun}` : `${total} ${noun}`;
    }
    if (filterEmpty) filterEmpty.hidden = visible !== 0;
  }

  search?.addEventListener("input", updateFilter);

  // Sort by the value stored on each cell; the visible text remains human-friendly.
  table.querySelectorAll("[data-sort-column]").forEach((button) => {
    button.addEventListener("click", () => {
      const column = Number(button.dataset.sortColumn);
      sortDirection = sortedColumn === column && sortDirection === "asc" ? "desc" : "asc";
      sortedColumn = column;

      const direction = sortDirection === "asc" ? 1 : -1;
      rows.sort((left, right) => {
        const leftCell = left.cells[column];
        const rightCell = right.cells[column];
        const leftValue = (leftCell.dataset.sortValue ?? leftCell.textContent).trim();
        const rightValue = (rightCell.dataset.sortValue ?? rightCell.textContent).trim();
        return leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" }) * direction;
      });
      rows.forEach((row) => body.appendChild(row));

      table.querySelectorAll("thead th").forEach((heading) => heading.setAttribute("aria-sort", "none"));
      const heading = button.closest("th");
      heading.setAttribute("aria-sort", sortDirection === "asc" ? "ascending" : "descending");
      table.querySelectorAll(".sort-arrow").forEach((arrow) => { arrow.textContent = "↕"; });
      button.querySelector(".sort-arrow").textContent = sortDirection === "asc" ? "↑" : "↓";
    });
  });

  updateFilter();
});
