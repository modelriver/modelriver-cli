class Formatter {
  static json(data, indent = 2) {
    return JSON.stringify(data, null, indent);
  }

  static table(headers, rows) {
    // Simple table formatter
    const maxWidths = headers.map((header, i) => {
      const headerWidth = header.length;
      const maxRowWidth = Math.max(
        ...rows.map(row => String(row[i] || '').length)
      );
      return Math.max(headerWidth, maxRowWidth);
    });

    const formatRow = (row) => {
      return row.map((cell, i) => {
        const str = String(cell || '');
        return str.padEnd(maxWidths[i]);
      }).join('  ');
    };

    const headerRow = formatRow(headers);
    const separator = headers.map((_, i) => '─'.repeat(maxWidths[i])).join('  ');
    const dataRows = rows.map(formatRow);

    return [headerRow, separator, ...dataRows].join('\n');
  }

  static timestamp(date = new Date()) {
    return date.toISOString();
  }

  static formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }
}

module.exports = Formatter;


