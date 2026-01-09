const Formatter = require('./formatter');

describe('Formatter', () => {
    describe('json', () => {
        it('should format objects with default 2-space indentation', () => {
            const obj = { name: 'test', value: 123 };
            const result = Formatter.json(obj);

            expect(result).toBe('{\n  "name": "test",\n  "value": 123\n}');
        });

        it('should format with custom indentation', () => {
            const obj = { key: 'value' };
            const result = Formatter.json(obj, 4);

            expect(result).toBe('{\n    "key": "value"\n}');
        });

        it('should handle arrays', () => {
            const arr = [1, 2, 3];
            const result = Formatter.json(arr);

            expect(result).toBe('[\n  1,\n  2,\n  3\n]');
        });
    });

    describe('timestamp', () => {
        it('should return ISO format string', () => {
            const date = new Date('2024-01-09T12:00:00Z');
            const result = Formatter.timestamp(date);

            expect(result).toBe('2024-01-09T12:00:00.000Z');
        });

        it('should use current date when no argument provided', () => {
            const result = Formatter.timestamp();

            expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        });
    });

    describe('formatDuration', () => {
        it('should format milliseconds', () => {
            expect(Formatter.formatDuration(500)).toBe('500ms');
            expect(Formatter.formatDuration(999)).toBe('999ms');
        });

        it('should format seconds', () => {
            expect(Formatter.formatDuration(1000)).toBe('1.0s');
            expect(Formatter.formatDuration(5500)).toBe('5.5s');
            expect(Formatter.formatDuration(59999)).toBe('60.0s');
        });

        it('should format minutes', () => {
            expect(Formatter.formatDuration(60000)).toBe('1.0m');
            expect(Formatter.formatDuration(90000)).toBe('1.5m');
            expect(Formatter.formatDuration(300000)).toBe('5.0m');
        });
    });

    describe('table', () => {
        it('should format a simple table', () => {
            const headers = ['Name', 'Age'];
            const rows = [
                ['Alice', 30],
                ['Bob', 25]
            ];
            const result = Formatter.table(headers, rows);

            expect(result).toContain('Name');
            expect(result).toContain('Age');
            expect(result).toContain('Alice');
            expect(result).toContain('Bob');
        });

        it('should handle empty cells', () => {
            const headers = ['A', 'B'];
            const rows = [['value', null]];
            const result = Formatter.table(headers, rows);

            expect(result).toContain('value');
        });
    });
});
