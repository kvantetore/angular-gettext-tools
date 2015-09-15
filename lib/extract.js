'use strict';

var cheerio = require('cheerio');
var Po = require('pofile');
var ts = require("typescript");
var search = require('binary-search');
var _ = require('lodash');

var escapeRegex = /[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g;
var noContext = '$$noContext';

var angularExpressionTranslateExtractor = require('../lib/parse');
var parseForFilters = angularExpressionTranslateExtractor();

function mkAttrRegex(startDelim, endDelim) {
    var start = startDelim.replace(escapeRegex, '\\$&');
    var end = endDelim.replace(escapeRegex, '\\$&');

    if (start === '' && end === '') {
        start = '^';
    } else {
        // match optional :: (Angular 1.3's bind once syntax) without capturing
        start += '(?:\\s*\\:\\:\\s*)?';
    }

    return new RegExp(start + '\\s*(\'|"|&quot;|&#39;)(.*?)\\1\\s*\\|\\s*translate\\s*(' + end + '|\\|)', 'g');
}

function mkInterpolateRegex(startDelim, endDelim) {
    var start = startDelim.replace(escapeRegex, '\\$&');
    var end = endDelim.replace(escapeRegex, '\\$&');
    return new RegExp(start + '\\s*(?:::)?(.*?)' + end, 'g');
}

var noDelimRegex = mkAttrRegex('', '');

function localeCompare(a, b) {
    return a.localeCompare(b);
}

function comments2String(comments) {
    return comments.join(', ');
}

function walkJs(ast, node, fn, parentCommentRanges) {
    fn(node, parentCommentRanges);

    ts.forEachChild(node, function(child) {
        var commentRanges = ts.getLeadingCommentRangesOfNode(child, ast);
        if (commentRanges) {
            parentCommentRanges = commentRanges;
        }

        walkJs(ast, child, fn, parentCommentRanges);
    });
}

function getJSExpression(node) {
    var res = '';
    if (node.kind === ts.SyntaxKind.StringLiteral) {
        res = node.text;
    }
    if (node.kind === ts.SyntaxKind.BinaryExpression && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        res += getJSExpression(node.left);
        res += getJSExpression(node.right);
    }
    return res;
}

var Extractor = (function () {
    function Extractor(options) {
        this.options = _.extend({
            startDelim: '{{',
            endDelim: '}}',
            markerName: 'gettext',
            markerNames: [],
            lineNumbers: true,
            extensions: {
                htm: 'html',
                html: 'html',
                php: 'html',
                phtml: 'html',
                tml: 'html',
                ejs: 'html',
                erb: 'html',
                js: 'js'
            },
            postProcess: function (po) {}
        }, options);
        this.options.markerNames.unshift(this.options.markerName);
        
        //typescript mangles names starting with double underscore
        this.options.markerNames = this.options.markerNames.map(function (n) {
            return n.substring(0, 2) !== "__" ? n : "_" + n;
        })

        this.strings = {};
        this.attrRegex = mkAttrRegex(this.options.startDelim, this.options.endDelim);
        this.interpolateRegex = mkInterpolateRegex(this.options.startDelim, this.options.endDelim);
    }

    Extractor.isValidStrategy = function (strategy) {
        return strategy === 'html' || strategy === 'js';
    };

    Extractor.mkAttrRegex = mkAttrRegex;
    Extractor.mkInterpolateRegex = mkInterpolateRegex;

    Extractor.prototype.addString = function (reference, string, plural, extractedComment, context) {
        // maintain backwards compatibility
        if (_.isString(reference)) {
            reference = { file: reference };
        }

        string = string.trim();

        if (string.length === 0) {
            return;
        }

        if (!context) {
            context = noContext;
        }

        if (!this.strings[string]) {
            this.strings[string] = {};
        }

        if (!this.strings[string][context]) {
            this.strings[string][context] = new Po.Item();
        }

        var item = this.strings[string][context];
        item.msgid = string;

        var refString = reference.file;
        if (this.options.lineNumbers && reference.location && reference.location.start) {
            var line = reference.location.start.line;
            if (line || line === 0) {
                refString += ':' + reference.location.start.line;
            }
        }
        var refIndex = search(item.references, refString, localeCompare);
        if (refIndex < 0) { // don't add duplicate references
            // when not found, binary-search returns -(index_where_it_should_be + 1)
            item.references.splice(Math.abs(refIndex + 1), 0, refString);
        }

        if (context !== noContext) {
            item.msgctxt = context;
        }

        if (plural && plural !== '') {
            if (item.msgid_plural && item.msgid_plural !== plural) {
                throw new Error('Incompatible plural definitions for ' + string + ': ' + item.msgid_plural + ' / ' + plural + ' (in: ' + (item.references.join(', ')) + ')');
            }
            item.msgid_plural = plural;
            item.msgstr = ['', ''];
        }
        if (extractedComment) {
            var commentIndex = search(item.extractedComments, extractedComment, localeCompare);
            if (commentIndex < 0) { // don't add duplicate comments
                item.extractedComments.splice(Math.abs(commentIndex + 1), 0, extractedComment);
            }
        }
    };

    Extractor.prototype.extractJs = function (filename, src, lineNumber) {
        // used for line number of JS in HTML <script> tags
        lineNumber = lineNumber || 0;

        var self = this;
        var syntax;
        try {
            syntax = ts.createSourceFile(filename, src, ts.ScriptTarget.ES5);
        } catch (err) {
            return;
        }

        function getMethodNameNode(node) {
            if (node.expression.kind === ts.SyntaxKind.Identifier) {
                return node.expression;
            }
            else if (node.expression.kind == ts.SyntaxKind.PropertyAccessExpression) {
                return node.expression.name
            }
        }
        
        function getObjectNameNode(node) {
            if (node.expression.kind == ts.SyntaxKind.PropertyAccessExpression) {
                var objectNode = node.expression.expression;
                if (objectNode.kind === ts.SyntaxKind.Identifier) {
                    return objectNode;
                } else if (objectNode.kind === ts.SyntaxKind.PropertyAccessExpression) {
                    return objectNode.name;
                }
            }
        }

        function isGettext(node) {
            var nameNode = getMethodNameNode(node);
            return node !== null &&
                self.options.markerNames.indexOf(nameNode.text) >= 0 &&
                node.arguments !== undefined &&
                node.arguments.length > 0;
        }

        function isGetString(node) {
            var nameNode = getMethodNameNode(node);
            var objectNode = getObjectNameNode(node);
            return node !== null &&
                nameNode.text === "getString" &&
                objectNode.text === "gettextCatalog"
                node.arguments !== null &&
                node.arguments.length > 0;
        }

        function isGetPlural(node) {
            var nameNode = getMethodNameNode(node);
            var objectNode = getObjectNameNode(node);
            return node !== null &&
                nameNode.text === "getPlural" &&
                objectNode.text === "gettextCatalog"
                node.arguments !== null &&
                node.arguments.length > 0;
        }

        walkJs(syntax, syntax, function (node, parentCommentRanges) {
            if (node.kind !== ts.SyntaxKind.CallExpression) {
                return;
            }
            
            var str;
            var context;
            var singular;
            var plural;
            var extractedComments = [];
            var reference = {
                file: filename,
                location: {
                    start: {
                        line: ts.getLineAndCharacterOfPosition(syntax, getMethodNameNode(node).end).line + 1 + lineNumber
                    }
                }
            };

            if (isGettext(node) || isGetString(node)) {
                str = getJSExpression(node.arguments[0]);
                if (node.arguments[2]) {
                    context = getJSExpression(node.arguments[2]);
                }
            } else if (isGetPlural(node)) {
                singular = getJSExpression(node.arguments[1]);
                plural = getJSExpression(node.arguments[2]);
            }
            if (str || singular) {
                var commentRanges = ts.getLeadingCommentRangesOfNode(node, syntax) || parentCommentRanges;
                if (commentRanges !== undefined) {
                    commentRanges.forEach(function (range) {
                        var comment = syntax.text.substring(range.pos, range.end);
                        if (comment.match(/^\/\/\/ .*/)) {
                            extractedComments.push(comment.replace(/^\/\/\/ /, ''));
                        }
                    });
                }
                
                if (str) {
                    self.addString(reference, str, plural, comments2String(extractedComments), context);
                } else if (singular) {
                    self.addString(reference, singular, plural, comments2String(extractedComments));
                }
            }
        });
    };

    Extractor.prototype.extractHtml = function (filename, src) {
        var extractHtml = function (src, lineNumber) {
            var $ = cheerio.load(src, { decodeEntities: false, withStartIndices: true });
            var self = this;

            var newlines = function (index) {
                return src.substr(0, index).match(/\n/g) || [];
            };
            var reference = function (index) {
                return {
                    file: filename,
                    location: {
                        start: {
                            line: lineNumber + newlines(index).length + 1
                        }
                    }
                };
            };

            $('*').each(function (index, n) {
                var node = $(n);
                var getAttr = function (attr) {
                    return node.attr(attr) || node.data(attr);
                };
                var str = node.html();
                var plural = getAttr('translate-plural');
                var extractedComment = getAttr('translate-comment');
                var context = getAttr('translate-context');

                if (n.name === 'script') {
                    if (n.attribs.type === 'text/ng-template') {
                        extractHtml(node.text(), newlines(n.startIndex).length);
                        return;
                    }

                    // In HTML5, type defaults to text/javascript.
                    // In HTML4, it's required, so if it's not there, just assume it's JS
                    if (!n.attribs.type || n.attribs.type === 'text/javascript') {
                        self.extractJs(filename, node.text(), newlines(n.startIndex).length);
                        return;
                    }
                }

                if (node.is('translate')) {
                    self.addString(reference(n.startIndex), str, plural, extractedComment);
                    return;
                }

                var matches;
                var filterIndex;
                var attrFilter;
                var attrFilters;
                var isTranslateTag = false;
                for (var attr in node.attr()) {
                    if (attr === 'translate' || attr === 'data-translate') {
                        isTranslateTag = true;
                        str = node.html(); // this shouldn't be necessary, but it is
                        self.addString(reference(n.startIndex), str, plural, extractedComment, context);
                    } else if (node.attr(node) != "") {
                        if (matches = self.interpolateRegex.exec(node.attr(attr))) {
                            //try to parse attribute and find angular interpolations
                            do {
                                //for each interpolation expression, parse the expression to find
                                //any translate filters
                                attrFilters = parseForFilters(matches[1]);
                                for (filterIndex = 0; filterIndex<attrFilters.length; filterIndex++) {
                                    attrFilter = attrFilters[filterIndex];
                                    self.addString(reference(n.startIndex), attrFilter.msgid);
                                }
                            } while (matches = self.interpolateRegex.exec(node.attr(attr)));
                        } else {
                            //without any interpolation strings, try to parse the attribute as an angular expression
                            //to find translate filters
                            attrFilters = parseForFilters(node.attr(attr));
                            for (filterIndex = 0; filterIndex<attrFilters.length; filterIndex++) {
                                attrFilter = attrFilters[filterIndex];
                                self.addString(reference(n.startIndex), attrFilter.msgid);
                            }
                        }
                    }
                }
                
                if (!isTranslateTag) {
                    //try to find any interpolation strings in the text child elements
                    for (var i = 0, len = n.childNodes.length; i < len; ++i) {
                        var childNode = n.childNodes[i];
                        if (childNode.nodeType === 3 /* text */ ) {
                            var text = childNode.data;
                            while (matches = self.interpolateRegex.exec(text)) {
                                //parse interpolation expression for translate filters
                                attrFilters = parseForFilters(matches[1]);
                                for (filterIndex = 0; filterIndex<attrFilters.length; filterIndex++) {
                                    attrFilter = attrFilters[filterIndex];
                                    self.addString(reference(childNode.startIndex), attrFilter.msgid);
                                }
                            }
                        }
                    }
                } 
            });
        }.bind(this);

        extractHtml(src, 0);
    };
    
    Extractor.prototype.isSupportedByStrategy = function (strategy, extension) {
        return (extension in this.options.extensions) && (this.options.extensions[extension] === strategy);
    };

    Extractor.prototype.parse = function (filename, content) {
        var extension = filename.split('.').pop();

        if (this.isSupportedByStrategy('html', extension)) {
            this.extractHtml(filename, content);
        }
        if (this.isSupportedByStrategy('js', extension)) {
            this.extractJs(filename, content);
        }
    };

    Extractor.prototype.toString = function () {
        var catalog = new Po();

        catalog.headers = {
            'Content-Type': 'text/plain; charset=UTF-8',
            'Content-Transfer-Encoding': '8bit',
            'Project-Id-Version': ''
        };

        for (var msgstr in this.strings) {
            var msg = this.strings[msgstr];
            var contexts = Object.keys(msg).sort();
            for (var i = 0; i < contexts.length; i++) {
                catalog.items.push(msg[contexts[i]]);
            }
        }

        catalog.items.sort(function (a, b) {
            return a.msgid.localeCompare(b.msgid);
        });

        this.options.postProcess(catalog);

        return catalog.toString();
    };

    return Extractor;
})();

module.exports = Extractor;
