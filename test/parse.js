'use strict';

var angularExpressionTranslateExtractor = require('../lib/parse');

// ----- End of extractor
// ----- Now here some tests for demonstration:

var assert = require('assert');
var parseForFilters = angularExpressionTranslateExtractor();

function generateTest( name, txt, expected, only) {
    var f = only ? it.only : it;
    f(name, function () {
        var actual = parseForFilters(txt);

        assert.deepEqual(actual, expected);
    });
}

describe('Extract: Filters using angular AST ', function () {
    generateTest('Matches a simple string', '\'Hello\'|translate', [ { msgid: 'Hello' } ]);

    generateTest('Matches a simple string with multiple filters', '\'Hello\'|translate|lowercase', [ { msgid: 'Hello' } ]);

    generateTest('Matches double quotes', '"Hello"|translate', [ { msgid: 'Hello' } ]);

    generateTest('Matches double quotes with multiple filters', '\'Hello\'|translate|lowercase', [ { msgid: 'Hello' } ]);

    generateTest('Matches spaces', '"Hello" | translate', [ { msgid: 'Hello' } ]);

    generateTest('Matches spaces with multiple filters', '"Hello" | translate | lowercase', [ { msgid: 'Hello' } ]);

    generateTest('Matches filter in ternary expression', 'foo ? ("Hello" | translate | lowercase) : ("bar" | translate)', [ { msgid: 'Hello' },  { msgid: 'bar' }]);

    generateTest('Matches filter in object expression', '{x: ("hello" | translate)}', [ { msgid: 'hello' } ]);
});