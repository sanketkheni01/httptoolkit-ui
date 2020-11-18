import * as _ from 'lodash';

import { CollectedEvent } from '../http/events-store';
import { HttpExchange } from '../http/exchange';
import { getStatusDocs } from '../http/http-docs';

import {
    charRange,
    FixedLengthNumberSyntax,
    FixedStringSyntax,
    NumberSyntax,
    StringOptionsSyntax,
    StringSyntax,
    SyntaxPart,
    SyntaxPartValue
} from './syntax-parts';

export abstract class Filter {

    abstract matches(event: CollectedEvent): boolean;
    abstract toString(): String;

    constructor(
        private readonly filterString: String
    ) {}

    serialize() {
        return this.filterString;
    }
}

export type FilterSet = [StringFilter, ...Filter[]] | [];

export type FilterClass<T extends unknown = never> = {
    /**
     * The constructor for the filter, which can take a string that fully matches
     * all syntax parts of this filter.
     */
    new (input: string): Filter;

    /**
     * A list of syntax parts that describe how to enter the filter as a string.
     *
     * Filter syntax parts may accept hint context data, of type T.
     */
    filterSyntax: readonly SyntaxPart<any, T>[];

    /**
     * A function which takes a string that fully or partially matches the
     * syntax parts for this input, and returns a human readable descriptio
     * of what the filter will do.
     *
     * This function can safely assume it will never be called with strings
     * that do not match the syntax parts.
     *
     * Generally, this should get more precise as more input is entered.
     */
    filterDescription: (input: string) => string;
};

/**
 * Special case: this is the standard string matching filter.
 * Always exactly one used, with the raw text input from the
 * filter field, never added as a filter tag.
 */
export class StringFilter extends Filter {
    constructor(
        public readonly filter: string
    ) {
        super(filter);
    }

    matches(event: CollectedEvent): boolean {
        if (this.filter === '') return true;
        const filter = this.filter.toLocaleLowerCase();
        return event.searchIndex.includes(filter);
    }

    toString() {
        return `"${this.filter}"`;
    }
}

const operations = {
    "=": (value: any, expected: any) => value === expected,
    "!=": (value: any, expected: any) => value !== expected
} as const;

const numberOperations = {
    ...operations,
    ">": (value: number, expected: number) => value > expected,
    ">=": (value: number, expected: number) => value >= expected,
    "<": (value: number, expected: number) => value < expected,
    "<=": (value: number, expected: number) => value <= expected
}

// Note that all operations here are implicitly case-sensitive, but it's expected
// that each matcher will lower/uppercase values for matching as part of parsing.
const stringOperations = {
    ...operations,
    "*=": (value: string, expected: string) => value.includes(expected),
    "^=": (value: string, expected: string) => value.startsWith(expected),
    "$=": (value: string, expected: string) => value.endsWith(expected)
};

type NumberOperation = keyof typeof numberOperations;
type StringOperation = keyof typeof stringOperations;

const operationDescriptions: { [key in NumberOperation | StringOperation]: string } = {
    "=": "equal to",
    "!=": "not equal to",
    ">": "greater than",
    ">=": "greater than or equal to",
    "<": "less than",
    "<=": "less than or equal to",
    "*=": "containing",
    "^=": "that starts with",
    "$=": "that ends with"
} as const;

type SyntaxPartValues<
    F extends FilterClass,
    S = F['filterSyntax']
> = { [K in keyof S]: S[K] extends SyntaxPart ? SyntaxPartValue<S[K]> : never }

/**
 * Given that there's a full match for the given filter against the given input,
 * parse the input with the syntax array of the filter and return an array of
 * the parsed values.
 *
 * Throws an error if the value does not fully match the filter.
 */
function parseFilter<F extends FilterClass>(filterClass: F, value: string): SyntaxPartValues<F> {
    let index = 0;
    const parts = [];

    for (let part of filterClass.filterSyntax) {
        parts.push(part.parse(value, index));
        index += part.match(value, index)!.consumed;
    }

    return parts as unknown as SyntaxPartValues<F>;
}

/**
 * Try to parse the filter, returning an array of all syntax parts that can be
 * parsed successfully, but stopping as soon as a part does not match.
 */
function tryParseFilter<F extends FilterClass>(filterClass: F, value: string): Partial<SyntaxPartValues<F>> {
    let index = 0;
    const parts = [];

    for (let part of filterClass.filterSyntax) {
        const match = part.match(value, index);
        if (!match || match.type !== 'full') break;

        parts.push(part.parse(value, index));
        index += match.consumed;
    }

    return parts as unknown as Partial<SyntaxPartValues<F>>;
}

class StatusFilter extends Filter {

    static filterSyntax = [
        new FixedStringSyntax("status"),
        new StringOptionsSyntax<NumberOperation>([
            "=",
            "!=",
            ">=",
            ">",
            "<=",
            "<"
        ]),
        new FixedLengthNumberSyntax(3, {
            suggestionGenerator: (_v, _i, events: CollectedEvent[]) =>
                _(events)
                .map(e =>
                    'response' in e &&
                    e.isSuccessfulExchange() &&
                    e.response.statusCode.toString()
                )
                .uniq()
                .filter(Boolean)
                .sort()
                .valueOf() as string[]
        })
    ] as const;

    static filterDescription(value: string) {
        const [, op, status] = tryParseFilter(StatusFilter, value);

        if (!op || (op == '=' && !status)) {
            return "Match responses with a given status code";
        } else if (!status) {
            return `Match responses with a status ${operationDescriptions[op]} a given value`
        } else {
            const statusMessage = getStatusDocs(status)?.message;

            // For exact matches, include the status description for easy reference
            const describeStatus = (op === '=' || op === '!=') && statusMessage
                ? ` (${statusMessage})`
                : '';

            if (op === '=') {
                // Simplify descriptions for the most common case
                return `Match responses with status ${status}${describeStatus}`;
            } else {
                return `Match responses with a status ${
                    operationDescriptions[op]
                } ${status}${describeStatus}`
            }
        }
    }

    private status: number;
    private op: NumberOperation;
    private predicate: (status: number, expectedStatus: number) => boolean;

    constructor(filter: string) {
        super(filter);
        [, this.op, this.status] = parseFilter(StatusFilter, filter);
        this.predicate = numberOperations[this.op];
    }

    matches(event: CollectedEvent): boolean {
        return event instanceof HttpExchange &&
            event.isSuccessfulExchange() &&
            this.predicate(event.response.statusCode, this.status);
    }

    toString() {
        return `Status ${this.op} ${this.status}`;
    }
}

class CompletedFilter extends Filter {

    static filterSyntax = [new FixedStringSyntax("completed")] as const;

    static filterDescription(value: string) {
        return "Match requests that have received a response";
    }

    matches(event: CollectedEvent): boolean {
        return event instanceof HttpExchange &&
            event.isSuccessfulExchange();
    }

    toString() {
        return `Completed`;
    }
}

class PendingFilter extends Filter {

    static filterSyntax = [new FixedStringSyntax("pending")];

    static filterDescription(value: string) {
        return "Match requests that are still waiting for a response";
    }

    matches(event: CollectedEvent): boolean {
        return event instanceof HttpExchange &&
            !event.isCompletedExchange();
    }

    toString() {
        return `Pending`;
    }
}

class AbortedFilter extends Filter {

    static filterSyntax = [new FixedStringSyntax("aborted")] as const;

    static filterDescription(value: string) {
        return "Match requests that aborted before receiving a response";
    }

    matches(event: CollectedEvent): boolean {
        return event instanceof HttpExchange &&
            event.response === 'aborted'
    }

    toString() {
        return `Aborted`;
    }
}

class ErrorFilter extends Filter {

    static filterSyntax = [new FixedStringSyntax("errored")] as const;

    static filterDescription(value: string) {
        return "Match requests that weren't transmitted successfully";
    }

    matches(event: CollectedEvent): boolean {
        return !(event instanceof HttpExchange) || // TLS Error
            event.tags.some(tag =>
                tag.startsWith('client-error') ||
                tag.startsWith('passthrough-error')
            );
    }

    toString() {
        return `Error`;
    }
}

class MethodFilter extends Filter {

    static filterSyntax = [
        new FixedStringSyntax("method"),
        new FixedStringSyntax("="),
        new StringSyntax("method", {
            allowedChars: [
                charRange('a', 'z'),
                charRange('A', 'Z')
            ],
            suggestionGenerator: (_v, _i, events: CollectedEvent[]) =>
                _(events)
                .map(e => 'request' in e && e.request.method)
                .uniq()
                .filter(Boolean)
                .valueOf() as string[]
        })
    ] as const;

    static filterDescription(value: string) {
        const [, , method] = tryParseFilter(MethodFilter, value);

        if (!method) {
            return "Match requests with a given method";
        } else {
            return `Match ${method.toUpperCase()} requests`;
        }
    }

    private expectedMethod: string;

    constructor(filter: string) {
        super(filter);
        const [,, method] = parseFilter(MethodFilter, filter);
        this.expectedMethod = method.toUpperCase();
    }

    matches(event: CollectedEvent): boolean {
        return event instanceof HttpExchange &&
            event.request.method.toUpperCase() === this.expectedMethod;
    }

    toString() {
        return `Method = ${this.expectedMethod}`;
    }

}

class HttpVersionFilter extends Filter {

    static filterSyntax = [
        new FixedStringSyntax("httpVersion"),
        new FixedStringSyntax("="), // Separate, so initial suggestions are names only
        new StringOptionsSyntax(["1", "2"])
    ] as const;

    static filterDescription(value: string) {
        const [, , version] = tryParseFilter(HttpVersionFilter, value);

        if (!version) {
            return "Match exchanges using a given version of HTTP";
        } else {
            return `Match exchanges using HTTP/${version}`;
        }
    }

    private expectedVersion: number;

    constructor(filter: string) {
        super(filter);
        const [,, versionString] = parseFilter(HttpVersionFilter, filter);
        this.expectedVersion = parseInt(versionString, 10);
    }

    matches(event: CollectedEvent): boolean {
        return event instanceof HttpExchange &&
            event.httpVersion === this.expectedVersion;
    }

    toString() {
        return `HTTP ${this.expectedVersion}`;
    }
}

class ProtocolFilter extends Filter {

    static filterSyntax = [
        new FixedStringSyntax("protocol"),
        new FixedStringSyntax("="),
        new StringOptionsSyntax([
            "http",
            "https"
        ])
    ] as const;

    static filterDescription(value: string) {
        const [, , protocol] = tryParseFilter(ProtocolFilter, value);

        if (!protocol) {
            return "Match exchanges using either HTTP or HTTPS";
        } else {
            return `Match exchanges using ${protocol.toUpperCase()}`;
        }
    }

    private expectedProtocol: string;

    constructor(filter: string) {
        super(filter);
        const [,, protocol] = parseFilter(ProtocolFilter, filter);
        this.expectedProtocol = protocol.toLowerCase();
    }

    matches(event: CollectedEvent): boolean {
        if (!(event instanceof HttpExchange)) return false;

        // Parsed protocol is either http: or https:, so we strip the colon
        const protocol = event.request.parsedUrl.protocol.toLowerCase().slice(0, -1);
        return protocol === this.expectedProtocol;
    }

    toString() {
        return `${this.expectedProtocol.toUpperCase()}`;
    }
}

class HostnameFilter extends Filter {

    static filterSyntax = [
        new FixedStringSyntax("hostname"),
        new StringOptionsSyntax<StringOperation>([
            "=",
            "!=",
            "*=",
            "^=",
            "$="
        ]),
        new StringSyntax("hostname", {
            allowedChars: [
                charRange("a", "z"),
                charRange("A", "Z"),
                charRange("0", "9"),
                charRange("-"),
                charRange(".")
            ],
            suggestionGenerator: (_v, _i, events: CollectedEvent[]) =>
                _(events)
                .map(e => 'request' in e && e.request.parsedUrl.hostname.toLowerCase())
                .uniq()
                .filter(Boolean)
                .valueOf() as string[]
        })
    ] as const;

    static filterDescription(value: string) {
        const [, op, hostname] = tryParseFilter(HostnameFilter, value);

        if (!op || (!hostname && op === '=')) {
            return "Match requests sent to a given hostname";
        } else if (op === '=') {
            return `Match requests to ${hostname}`;
        } else {
            return `Match requests to a hostname ${operationDescriptions[op]} ${hostname || 'a given value'}`;
        }
    }

    private expectedHostname: string;
    private op: StringOperation;
    private predicate: (host: string, expectedHost: string) => boolean;

    constructor(filter: string) {
        super(filter);
        const [, op, hostname] = parseFilter(HostnameFilter, filter);
        this.op = op;
        this.predicate = stringOperations[op];
        this.expectedHostname = hostname.toLowerCase();
    }

    matches(event: CollectedEvent): boolean {
        return event instanceof HttpExchange &&
            this.predicate(
                event.request.parsedUrl.hostname.toLowerCase(),
                this.expectedHostname
            );
    }

    toString() {
        return `Hostname ${this.op} ${this.expectedHostname}`;
    }
}

const PROTOCOL_DEFAULT_PORTS = {
    'http:': 80,
    'https:': 443
} as const;

class PortFilter extends Filter {

    static filterSyntax = [
        new FixedStringSyntax("port"),
        new StringOptionsSyntax<NumberOperation>([
            "=",
            "!=",
            ">=",
            ">",
            "<=",
            "<"
        ]),
        new NumberSyntax("port")
    ] as const;

    static filterDescription(value: string) {
        const [, op, port] = tryParseFilter(PortFilter, value);

        if (!op || (!port && op === '=')) {
            return "Match requests sent to a given port";
        } else if (op === '=') {
            return `Match requests to port ${port}`;
        } else {
            return `Match requests to a port ${operationDescriptions[op]} ${port || 'a given port'}`;
        }
    }

    private expectedPort: number;
    private op: NumberOperation;
    private predicate: (port: number, expectedPort: number) => boolean;

    constructor(filter: string) {
        super(filter);
        [, this.op, this.expectedPort] = parseFilter(PortFilter, filter);
        this.predicate = numberOperations[this.op];
    }

    matches(event: CollectedEvent): boolean {
        if (!(event instanceof HttpExchange)) return false;

        const { protocol, port: explicitPort } = event.request.parsedUrl;
        const port = parseInt((
            explicitPort ||
            PROTOCOL_DEFAULT_PORTS[protocol as 'http:' | 'https:'] ||
            0
        ).toString(), 10);

        return event instanceof HttpExchange &&
            this.predicate(port, this.expectedPort);
    }

    toString() {
        return `Port ${this.op} ${this.expectedPort}`;
    }
}

class PathFilter extends Filter {

    static filterSyntax = [
        new FixedStringSyntax("path"),
        new StringOptionsSyntax<StringOperation>([
            "=",
            "!=",
            "*=",
            "^=",
            "$="
        ]),
        new StringSyntax("path", {
            suggestionGenerator: (_v, _i, events: CollectedEvent[]) =>
                _(events)
                .map(e => 'request' in e && e.request.parsedUrl.pathname)
                .uniq()
                .filter(Boolean)
                .valueOf() as string[]
        })
    ] as const;

    static filterDescription(value: string) {
        const [, op, path] = tryParseFilter(PathFilter, value);

        if (!op || (!path && op === '=')) {
            return "Match requests sent to a given path";
        } else if (op === '=') {
            return `Match requests to ${path}`;
        } else {
            return `Match requests to a path ${operationDescriptions[op]} ${path || 'a given path'}`;
        }
    }

    private expectedPath: string;
    private op: StringOperation;
    private predicate: (path: string, expectedPath: string) => boolean;

    constructor(filter: string) {
        super(filter);
        [, this.op, this.expectedPath] = parseFilter(PathFilter, filter);
        this.predicate = stringOperations[this.op];
    }

    matches(event: CollectedEvent): boolean {
        return event instanceof HttpExchange &&
            this.predicate(event.request.parsedUrl.pathname, this.expectedPath);
    }

    toString() {
        return `Path ${this.op} ${this.expectedPath}`;
    }
}

class QueryFilter extends Filter {

    static filterSyntax = [
        new FixedStringSyntax("query"),
        new StringOptionsSyntax<StringOperation>([
            "=",
            "!=",
            "*=",
            "^=",
            "$="
        ]),
        new StringSyntax("query", {
            allowEmpty: true,
            suggestionGenerator: (_v, _i, events: CollectedEvent[]) =>
                _(events)
                .map(e => 'request' in e && e.request.parsedUrl.search)
                .uniq()
                .filter(Boolean)
                .valueOf() as string[]
        })
    ] as const;

    static filterDescription(value: string) {
        const [, op, query] = tryParseFilter(QueryFilter, value);

        if (!op) {
            return "Match requests with a given query string";
        } else {
            return `Match requests with a query string ${operationDescriptions[op]} ${
                query || 'a given query string'
            }`;
        }
    }

    private expectedQuery: string;
    private op: StringOperation;
    private predicate: (query: string, expectedQuery: string) => boolean;

    constructor(filter: string) {
        super(filter);
        [, this.op, this.expectedQuery] = parseFilter(QueryFilter, filter);
        this.predicate = stringOperations[this.op];
    }

    matches(event: CollectedEvent): boolean {
        return event instanceof HttpExchange &&
            this.predicate(event.request.parsedUrl.search, this.expectedQuery);
    }

    toString() {
        return `Query ${this.op} ${this.expectedQuery}`;
    }
}

export const SelectableSearchFilterClasses: FilterClass[] = [
    MethodFilter,
    HostnameFilter,
    PathFilter,
    QueryFilter,
    StatusFilter,
    CompletedFilter,
    PendingFilter,
    AbortedFilter,
    ErrorFilter,
    PortFilter,
    ProtocolFilter,
    HttpVersionFilter,
];