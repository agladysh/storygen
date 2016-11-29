ace.define('ace/mode/storygen', function(acerequire, exports, module) {

var oop = acerequire("ace/lib/oop");
var TextMode = acerequire("ace/mode/text").Mode;
var StorygenHighlightRules = acerequire("ace/mode/storygen_highlight_rules").StorygenHighlightRules;

var Mode = function() {
    this.HighlightRules = StorygenHighlightRules;
};
oop.inherits(Mode, TextMode);

(function() {
  this.type = "text";
  this.$id = "ace/mode/storygen";
}).call(Mode.prototype);

exports.Mode = Mode;
});

ace.define('ace/mode/storygen_highlight_rules', function(acerequire, exports, module) {

var oop = acerequire("ace/lib/oop");
var TextHighlightRules = acerequire("ace/mode/text_highlight_rules").TextHighlightRules;

var StorygenHighlightRules = function() {
  var tokens = {
    // variable.language
  };

  this.$rules = {
    "start": [
      {
        token: [ "keyword" ],
        regex: /(\[)/,
        next: "inlinedictionary"
      },
      {
        token: [ "keyword" ],
        regex: /({)/,
        push: "placeholder"
      },
      {
        token: [ "keyword" ],
        regex: /(\#)/,
        next: "metadata-item"
      }
    ],

    "inlinedictionary": [
      {
        token: [ "keyword" ],
        regex: /({)/,
        push: "placeholder"
      },
      {
        token: [ "keyword.operator" ],
        regex: /([\^])/
      },
      {
        token: [ "string" ],
        regex: /([^\^\]\{]+)/
      },
      {
        token: [ "keyword" ],
        regex: /([\]])/,
        next: "start"
      }
    ],

    "metadata-item": [
      {
        token: [ "keyword" ],
        regex: /({)/,
        push: "placeholder"
      },
      {
        token: [ "variable", "keyword.operator" ],
        regex: /([^&=]+)([=])/
      },
      {
        token: [ "string" ],
        regex: /([^&=]+)/
      },
      {
        token: [ "keyword.operator" ],
        regex: /([&])/,
        next: "metadata-item"
      },
      {
        token: "string",
        regex: "$|^", // eol
        next: "start"
      }
    ],

    "placeholder": [
      {
        token: [ "keyword" ],
        regex: /(})/,
        next: "pop"
      },
      {
        token: [
          "constant",
          "keyword.operator",
          "variable.parameter",
          "keyword.operator",
          "string",
          "keyword.operator",
          "variable"
        ],
        regex: /([%]?)([=]?)([^|>}]*)([|]?)([^>}]*)([>]?)([^}]*)/
      }
    ]
  };

  this.normalizeRules();
}

oop.inherits(StorygenHighlightRules, TextHighlightRules);

exports.StorygenHighlightRules = StorygenHighlightRules;
});
