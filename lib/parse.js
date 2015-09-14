'use strict';

/**
 * This is a proof of concept for using the parser shipped with angular to parse and analyze expressions for the
 * possible use of the translate filter.
 *
 * It lets angular itself generate an AST and then walks the AST using a visitor to find occurrences of the translate
 * filter.
 *
 * The following is a factory that returns a function which accepts and angular expression and parses it.
 */
function angularExpressionTranslateExtractor() {
    function loadAngularWithAstAndLexerPublic() {
        // The problem is that angular's parser is not accessibly. Thus we hack the file to make it accessible for us.
        // We do this by modifying the angular.js file so that it publishes AST and Lexer as external API
        var fs = require('fs');
        var file = fs.readFileSync('node_modules/angular/angular.js', 'utf8');
        file = file.replace('function publishExternalAPI(angular) {', 'function publishExternalAPI(angular) { extend(angular, {\'AST\': AST, \'Lexer\': Lexer});');
        eval(file); // jshint ignore:line
    }

    function getNgParser() {

        // Mock these things, because otherwise the angular.js file will not parse:
        global.window = {
            location: {
                href: 'dummy'
            },
            addEventListener: function () {}
        };
        global.document = {
            createElement: function () {
                return {
                    setAttribute: function () {},
                    pathname: 'dummy'
                };
            },
            querySelector: function () {},
            addEventListener: function () {}
        };

        loadAngularWithAstAndLexerPublic();

        return new global.window.angular.AST(new global.window.angular.Lexer({ csp: false, expensiveChecks: false }));
    }

    var ngParser = getNgParser();

    function AstParser() {
        this.translateables = [];
    }

    AstParser.prototype = {
        visitProgram: function (node) {
            this.visitAll(node.body);
        },

        visitExpressionStatement: function (node) {
            this.visit(node.expression);
        },

        visitCallExpression: function (node) {
            if (node.callee.type === 'Identifier' && node.callee.name === 'translate' && node.filter) {
                this.parseTranslateFilterArguments.apply(this, node.arguments);
            }
            this.visitAll(node.arguments);
        },
        
        visitObjectExpression: function(node) {
            this.visitAll(node.properties);
        },

        visitConditionalExpression: function (node) {
            this.visit(node.alternate);
            this.visit(node.consequent);
        },
        
        visitProperty: function(node) {
            this.visit(node.value);  
        },

        visitAll: function (nodeArray) {
            var self = this;
            nodeArray.forEach(function (node) {
                self.visit(node);
            });
        },

        visit: function (node) {
            var visitMethodName = 'visit' + node.type;
            if (this[visitMethodName]) {
                this[visitMethodName](node);
            }
        },

        parseTranslateFilterArguments: function (msgIdArg) {
            if (msgIdArg.type !== 'Literal') {
                console.log('WARNING: Can only extract literals');
                return;
            }
            this.translateables.push({
                msgid: msgIdArg.value
            });
        }
    };

    function parseForFilters(txt) {
        txt = txt.replace(/(\&quot;)|(\&#39;)/g, '"');
        
        var astParser = new AstParser();
        try {
            var ast = ngParser.ast(txt);
        } catch (ex) {
            //console.warn("Could not parse expression", txt)
            return [];
        }
        astParser.visit(ast);
        return astParser.translateables;
    }

    return parseForFilters;
}


module.exports = angularExpressionTranslateExtractor;