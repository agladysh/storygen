"use strict";

var Base64 = require('js-base64').Base64;
var Chance = require('chance');
var LZString = require('lz-string');
var request = require('superagent');
var balanced = require('node-balanced');
var ace = require('brace');
require('brace/mode/storygen');
var math = require('mathjs');

var parseDictionaryEntry = function(entry) {
  if (!entry) {
    return {
      value: ""
    };
  }

  var matches = entry.match(/^([^#]+)[#]?(.*)/);
  var meta = { };
  if (matches[2]) {
    matches[2].split("&").forEach(function(match) {
      var param = match.split("=");
      meta[param[0]] = param[1] || "";
    });
  }
  return {
    value: matches[1],
    meta: meta
  };
};

var maybe_capitalize = function(ref, text) {
  var firstChar = ref.charAt(0);
  if (firstChar !== firstChar.toLocaleLowerCase()) {
    text = text.charAt(0).toLocaleUpperCase()
      + text.slice(1);
  }
  return text;
};

var handlers = { };

handlers.random_word = function(sampler, dictionaries, param/*, command*/) {
  if (param.capture) {
    return param;
  }
  if (typeof param === 'string' || param instanceof String) {
    param = { entry: { value: param }, value: param };
  }
  var key = param.value.toLocaleLowerCase();
  if (!dictionaries[key]) {
    console.warn("random_word: unknown dictionary", key);
    return false;
  }
  var entry = sampler(dictionaries[key]);
  // TODO: This should be expanded here (by calling fill_placeholders)
  return {
    entry: JSON.parse(JSON.stringify(entry)),
    value: maybe_capitalize(param.value, entry.value)
  };
};

handlers.a = function(sampler, dictionaries, param, command) {
  var result = handlers.random_word.call(this, sampler, dictionaries, param);
  if (!result) {
    return false;
  }
  if (!result.entry.meta || result.entry.meta.a === undefined) {
    var needAn = /^[aeiou]$/.test(result.value.charAt(0).toLocaleLowerCase());
    result.entry.meta = result.entry.meta || { };
    result.entry.meta.a = (needAn) ? "an" : "a"; // Memoize
  }
  result.value = maybe_capitalize(command[1], result.entry.meta.a)
    + " " + result.value;
  return result;
};

handlers["="] = function(sampler, dictionaries, param, command) {
  var result = handlers.random_word.call(this, sampler, dictionaries, param);
  if (!result) {
    return false;
  }
  var key = command[2].slice(1).toLocaleLowerCase();
  if (!result.entry.meta || result.entry.meta[key] === undefined) {
    var value = handlers.random_word.call(
      this, sampler, dictionaries, { value: key }
    );
    if (!value) {
      return false;
    }

    result.entry.meta = result.entry.meta || { };
    result.entry.meta[key] = value.value;
  }
  result.value = maybe_capitalize(
    command[2].charAt(1),
    result.entry.meta[key]
  );
  return result;
};

handlers["."] = function(sampler, dictionaries, param, command) {
  return param;
};

handlers["<"] = function(sampler, dictionaries, param, command) {
  if (param.entry) {
    param = param.entry.value;
  }
  var value = "<" + param + ">";
  return {
    entry: { value: value },
    value: value
  };
};

handlers["?"] = function(sampler, dictionaries, param, command) {
  var scope = handlers.random_word.call(this, sampler, dictionaries, param);
  if (!scope) {
    return false;
  }
  scope.entry.meta = scope.entry.meta || { };
  var expr = command[2].slice(1).toLocaleLowerCase();

  try {
    // TODO: Supply (to global math object via math.import) random()
    //       function from our chance.js, where chance.js object is created
    var result = this.math.eval(expr, scope.entry.meta);
    if (result.entry !== undefined) {
      return result;
    }
    result = "" + result;
    return { entry: { value: result }, value: result };
  } catch (e) {
    console.error("expr `" + expr + "` error:", e);
  }

  return false;
};

var unique_index = 0;

var handler_self = {
  math: math //.create() -- Hack. But .create kills performance
};
handler_self.math.import({
  glue: function() {
    return String.prototype.concat.apply("", arguments);
  },
  dump: function(param) {
    console.log("DUMP", typeof(param), param);
    return JSON.stringify(param);
  },
  gt: function(lhs, rhs) {
    return lhs > rhs;
  },
  gte: function(lhs, rhs) {
    return lhs >= rhs;
  },
  dict: function(param) {
    var result = handlers.random_word.call(
      handler_self, handler_self.sampler, handler_self.dictionaries, param
    );
    if (!result) {
      return '{?dict("' + param + '")|$_ERROR}'; // TODO: Restore context too
    }
    return result;
  },
  reply: function(value, text) {
    return "<" + value + "|" + text + ">";
  },
  reply_if: function(cond, value, text) {
    return (cond) ? "<" + value + "|" + text + ">" : "";
  },
  random: function(min, max) {
    return handler_self.sampler.sampler.chance.floating({
      min: min === undefined ? 0 : min,
      max: max === undefined ? 1 : max
    });
  }
}, { override: true });

var compile = function(template) {
  var commandRe = /^([%]?)([^|>]*)[|]?([^>]*)[>]?(.*?)$/;

  return function(sampler, dictionaries, context) {
    if (context === undefined) {
      context = { };
    }

    var replace = function(sampler, template, captures) {
      if (!template) {
        return "";
      }

      handler_self.sampler = sampler
      handler_self.dictionaries = dictionaries

      template = balanced.replacements({
        source: template,
        open: "[",
        close: "]",
        replace: function(dictionary/*, head, tail*/) {
          var key = "__inplace__" + (++unique_index);
          dictionaries[key] = dictionary.split("^").map(function(entry) {
            return parseDictionaryEntry(entry);
          });
          return handler_self.math.dict(key).value;
        }
      });

      var result = balanced.replacements({
        source: template,
        open: "{",
        close: "}",
        replace: function(command, head, tail) {
          if (command == "") {
            console.warn("commandless placeholder {} in", template);
            return head + command + tail;
          }

          var matches = command.match(commandRe);
          if (!matches) {
            console.warn("malformed command", command, "in", template);
            return head + command + tail; // Match failed.
          }

          var silent = matches[1];

          var action = matches[2]
            ? compile(matches[2])(sampler, dictionaries, context)
            : matches[2];
          var param = matches[3]
            ? compile(matches[3])(sampler, dictionaries, context)
            : matches[3];
          var toContextKey = matches[4]
            ? compile(matches[4])(sampler, dictionaries, context)
            : matches[4];

          if (!action && !param && !!toContextKey) {
            context[toContextKey] = { entry: { value: "" } };
            return "";
          }

          if (!param) {
            if (action === "\\n") {
              return "\n";
            }

            param = action;
            action = 'random_word';
          } else {
            action = action.toLocaleLowerCase();
          }

          if (action.charAt(0) === "=" || action.charAt(0) === "?") {
            action = action.charAt(0);
          }

          if (param.charAt(0) === "$") {
            var contextKey = param.slice(1);
            if (context[contextKey] === undefined) {
              console.warn("unknown context key", contextKey, "in", template);
              return head + command + tail;
            }

            var contextKeyFirstChar = param.charAt(1);
            param = context[contextKey];
            // Reset context value
            param.value = maybe_capitalize(
              contextKeyFirstChar,
              param.entry.value
            );
            param.capture = true;
          } else {
            param = { entry: { value: param }, value: param };
          }

          if (!handlers[action]) {
            console.warn(
              "unknown handler", action, "of command", command, "in", template
            );
            return head + command + tail;
          }

          var result = handlers[action].call(
            handler_self, sampler, dictionaries, param, matches
          );
          if (!result && result !== "") {
            console.warn(
              "handler", action, "of command", command, "failed in", template
            );
            return head + command + tail;
          }

          result.value = compile(result.value)(
            sampler, dictionaries, context
          );
          if (result.meta) {
            Object.keys(result.meta).forEach(function(key) {
              result.meta[key] = compile(result.meta[key])(
                sampler, dictionaries, context
              );
            });
          }

          if (toContextKey) {
            context[toContextKey] = result;
          }

          if (silent) {
            return "";
          }

          return "" + result.value;
        }
      });

      return "" + result;
    };

    var captures = [ ];
    var result = replace(sampler, template, captures);
    return "" + result;
  };
};

var fill_placeholders = function(sampler, template, dictionaries, context) {
  if (typeof template === 'object' && template !== null) {
    template = template.value;
  }
  if (typeof template === 'string' || template instanceof String) {
    template = compile(template);
  }

  return template(sampler, dictionaries, context);
};

var generate_one = function(sampler, data, sentence, context) {
  if (!sentence) {
    sentence = sampler(data.sentences);
  }
  var result = fill_placeholders(sampler, sentence, data.dictionaries, context);
  data.postprocessing.forEach(function(rule) {
    if (!(rule.find instanceof RegExp)) {
      rule.find = new RegExp(rule.find, "gm");
    }
    result = result.replace(rule.find, rule.replace);
  });
  return result;
};

var HTML = require("html.js");

var d = function(raw) {
  var result = { };
  Object.keys(raw).forEach(function(key) {
    result[key] = raw[key].map(parseDictionaryEntry);
  });
  return result;
};

var VERSION = "storygen-0.0.3";

var upgradeData = function(data) {
  var v0_0_2_to_v0_0_3_fixupInlineDictionary = function(str) {
    if (!str) {
      return str;
    }
    return balanced.replacements({
      source: str,
      open: "[",
      close: "]",
      replace: function(dictionary, head, tail) {
        return head + dictionary.replace(/,/g, "^") + tail;
      }
    });
  }

  switch (data.version) {
  case VERSION:
    return data;

  case "storygen-0.0.2":
    console.info("BEFORE 0.0.2->0.0.3 UPGRADE", JSON.stringify(data));
    Object.keys(data.payload.dictionaries).forEach(function(key) {
      data.payload.dictionaries[key] = data.payload.dictionaries[key].map(
        function(entry) {
          entry.value = v0_0_2_to_v0_0_3_fixupInlineDictionary(entry.value);
          Object.keys(entry.meta).forEach(function(key) {
            // NB: Inline dictionaries in the keys are, likely, useless so far.
            entry.meta[key] = v0_0_2_to_v0_0_3_fixupInlineDictionary(
              entry.meta[key]
            );
          });
          return entry;
        }
      );

      data.payload.sentences = data.payload.sentences.map(function(sentence) {
        return v0_0_2_to_v0_0_3_fixupInlineDictionary(sentence);
      });
    });
    data.version = "storygen-0.0.3";
    console.info("AFTER 0.0.2->0.0.3 UPGRADE", JSON.stringify(data));
    return upgradeData(data);

  default:
    console.error("no data upgrade path from", data.version);
    return false;
  }
};

var DATA;

var SERIALIZE = function() {
  return 'z' + LZString.compressToBase64(JSON.stringify({
    version: VERSION,
    payload: DATA
  }));
};

// TODO: Use LZString.compressToEncodedURIComponent
//       and LZString.decompressFromEncodedURIComponent

var UNSERIALIZE = function(str) {
  var data;
  if (str.charAt(0) === 'z') {
    data = JSON.parse(LZString.decompressFromBase64(str.slice(1)));
  } else if (str.charAt(0) === 'Z') {
    // Support older format
    data = require('lzwcompress').unpack(str.slice(1).split("").map(
      function(c) {
        return c.charCodeAt(0);
      }
    ));
  } else {
    data = JSON.parse(str); // Support even older format
  }

  if (!data) {
    return false;
  }

  if (data.version !== VERSION && !upgradeData(data)) {
    console.error("expected version", VERSION, "got version", data.version);
    alert("Data version mismatch");
    return;
  }

  DATA = data.payload;
  DATA.postprocessing = DATA.postprocessing || DEFAULT_DATA().postprocessing;
  DATA.preview = DATA.preview || DEFAULT_DATA().preview;
  DATA.meta = DATA.meta || DEFAULT_DATA().meta;
};

var CLEAR_DATA = function() { return {
  meta: {
    title: "Generator Title",
    author: "Generator Author @twitter",
    description: "Generator Description"
  },
  preview: {
    seed: 0,
    size: 42,
    overflow: true,
    separator: false
  },
  dictionaries: d({
    bool: [ "true", "false" ]
  }),
  sentences: [
    "This is {bool}."
  ],
  postprocessing: [ ]
}; };

var CHAT_DATA = function() { return {
  meta: {
    title: "Generator Title",
    author: "Generator Author @twitter",
    description: "Generator Description"
  },
  preview: {
    seed: 0,
    size: 0,
    overflow: false,
    separator: true
  },
  dictionaries: d({
    want: [ "Wo-hoo!", "Cool!" ],
    dontwant: [ "Oops!", "C'mon, man!" ]
  }),
  sentences: [
    "Hi! Want a story?<want|Yes!><dontwant|No!>",
    "Yo! Want a story?<want|Yes!><dontwant|No!>"
  ],
  postprocessing: [
    { find: " [ ]+", replace: " " },
    { find: ",[ ]*,", replace: "," },
    { find: " ([,.])", replace: "$1" }
  ]
}; };

var DEFAULT_DATA = function() { return {
  meta: {
    title: "Generator Title",
    author: "Generator Author @twitter",
    description: "Generator Description"
  },
  preview: {
    seed: 0,
    size: 42,
    overflow: true,
    separator: true
  },
  dictionaries: d({
    he: [ "he", "she" ],
    beautiful: [ "beautiful", "ugly" ],
    hobbit: [
      "hobbit",
      "ork",
      "elf#he=she",
      "robot#he=it"
    ],
    honest: [
      "honest#a=an&oops=wooho!&outcome={outcome_good}",
      "dishonest#oops=oops!&outcome={outcome_bad}"
    ],
    outcome_good: [
      "'You were a good {$race}. Here, take a pie' said {$opponent}."
    ],
    outcome_bad: [
      "'Bad, bad {$race}!', said {$opponent} and run away.'"
    ],

    он: [ "он", "она" ],
    красивый: [ "красивый", "уродливый" ],
    хоббит: [
      "хоббит",
      "орк",
      "эльф#он=она",
      "робото#он=оно"
    ],
    честный: [
      "честный#опа=ура!&финал={хороший_финал}",
      "нечестный#опа=опа!&финал={плохой_финал}"
    ],
    хороший_финал: [
      "'Ты был хорошим {$раса}. Вот, возьми пирог', сказал {$оппонент}."
    ],
    плохой_финал: [
      "'Плохой, плохой {$раса}!', сказал {$оппонент} и убежал.'"
    ]
  }),
  sentences: [
    "There was {a|Hobbit>race}. {A|$race} was {beautiful}.\n"
    + "{=He|$race} was {a|honest>honesty} {$race}. Once {=he|$race} saw"
    + " {a|hobbit>opponent}.\n"
    + "'Hi!' said {$opponent}. '{=Oops|$honesty}' said {$race}.\n"
    + "{=outcome|$honesty}",

    "Жил-был {Хоббит>раса}. {$раса} был {красивый}.\n"
    + "{=Он|$раса} был {честный>честность} {$раса}. Однажды {=он|$раса} увидел"
    + " {хоббит>оппонент}.\n"
    + "'Привет!', сказал {$оппонент}. '{=Опа|$честность}', сказал {$раса}.\n"
    + "{=финал|$честность}"
  ],
  postprocessing: [
    { find: " [ ]+", replace: " " },
    { find: ",[ ]*,", replace: "," },
    { find: " ([,.])", replace: "$1" }
  ]
}; };

var dataToUrl = function() {
  return "#/stories/" + Base64.encodeURI(SERIALIZE());
};

var urlToData = function() {
  if (!window.location.hash) {
    return false;
  }

  return Base64.decode(window.location.hash.slice(10));
};

var STORED;
try {
  STORED = urlToData();
} catch(e) {
  console.error("Failed to load data from url:", e);
  STORED = false;
}

if (STORED) {
  UNSERIALIZE(STORED);
}

if (!DATA) {
  DATA = DEFAULT_DATA();
}

DATA.postprocessing = DATA.postprocessing || DEFAULT_DATA().postprocessing;
DATA.preview = DATA.preview || DEFAULT_DATA().preview;
DATA.meta = DATA.meta || DEFAULT_DATA().meta;

var CHAT = { };

console.info("DATA", DATA);

var clear = function(dom) {
  while (dom.firstChild) {
    dom.removeChild(dom.firstChild);
  }
};

var makeSampler = function(chance) {
  var sampler = function(list) {
    if (list.length === 0) {
      return undefined;
    }

    list.samplerPicks = list.samplerPicks
      || list.slice().fill(0, 0, list.length);

    var lowestCount = Infinity;
    list.samplerPicks.forEach(function(count, index) {
      var weight = list[index].meta && list[index].meta.weight;
      if (weight === undefined || window.isNaN(+weight)) {
        weight = 1;
      }
      weight = +weight;
      if (weight > 0) {
        if (lowestCount === undefined || count < lowestCount) {
          lowestCount = count;
        }
      }
    });

    var candidates = [ ];
    var weights = [ ];
    list.samplerPicks.forEach(function(count, index) {
      var weight = list[index].meta && list[index].meta.weight;
      if (weight === undefined || window.isNaN(+weight)) {
        weight = 1;
      }
      weight = +weight;
      if (count === lowestCount && weight > 0) {
        candidates.push(index);
        weights.push(weight);
      }
    });

    var index = chance.weighted(candidates, weights);

    ++list.samplerPicks[index];

    return list[index];
  };
  sampler.chance = chance; // hack
  return sampler;
};

var updateChat; // Forward declaration

var onChatChange = function(reply) {
  CHAT.sample = CHAT.sample || makeSampler(new Chance(DATA.preview.seed));
  CHAT.data = CHAT.data || JSON.parse(JSON.stringify(DATA));
  CHAT.context = CHAT.context || { };

  var dictionary = reply && reply.value; // May be null
  var sentence = DATA.dictionaries[dictionary]
    ? CHAT.sample(DATA.dictionaries[dictionary])
    : null;

  var text = generate_one(
    CHAT.sample,
    CHAT.data,
    sentence,
    CHAT.context
  );

  CHAT.replies = [ ];
  CHAT.cue = balanced.replacements({
    source: text || "(NO TEXT)",
    open: "<",
    close: ">",
    replace: function(reply, head, tail) {
      var matches = reply.match(/^([^|]*)[|]?(.*)/);
      if (!matches[2]) {
        return head + reply + tail;
      }
      CHAT.replies.push({ text: matches[2], value: matches[1] });
      return "";
    }
  });

  updateChat();
};

var highlightErrors = function(parent, text) {
  var inError = false;
  text.split(/({|})/g).forEach(function(item) {
    if (!inError) {
      if (item === "{") {
        inError = true;
        parent.add("span.error").textContent = item;
      } else {
        parent.add("span").textContent = item;
      }
    } else {
      parent.add("span.error").textContent = item;
      if (item === "}") {
        inError = false;
      }
    }
  });
  return parent;
};

updateChat = function() {
  var chat = HTML.query("#chat");

  clear(chat);

  highlightErrors(chat.add("div.cue"), CHAT.cue);

  var replies = chat.add("div.replies");

  var addReply = function(reply) {
    var button = replies.add("button"); // Not highlighting errors...
    button.textContent = reply.text;
    button.addEventListener('click', function() {
      onChatChange(reply);
    });
  };

  if (!CHAT.replies || CHAT.replies.length === 0) {
    addReply({ text: "The End", value: null });
  } else {
    CHAT.replies.forEach(addReply);
  }
};

var updatePreview = function() {
  var preview = HTML.query("#preview");

  clear(preview);

  var chance = new Chance(DATA.preview.seed);

  var snapshot = JSON.stringify(DATA);
  for (var i = 0; i < DATA.preview.size; ++i) {
    if (i > 0 && DATA.preview.separator) {
      preview.add('hr');
    }

    var text = generate_one(makeSampler(chance), JSON.parse(snapshot));
    var div = preview.add('div');
    if (text.length <= 140 || !DATA.preview.overflow) {
      highlightErrors(div.add('span'), text);
    } else {
      highlightErrors(div.add('span'), text.slice(0, 140));
      highlightErrors(div.add('span.too-long'), text.slice(140));
    }
  }

  updateChat();

  if (DATA.preview.size === 0) {
    HTML.query("#chat").classList.remove("hidden");
  }
};

var addDictionary; // Forward declaration
var addSentence; // Forward declaration
var addPostProcessingRule; // Forward declaration

var redisplay = function() {
  clear(HTML.query("#dictionaries"));
  clear(HTML.query("#sentences"));
  clear(HTML.query("#hamburger-menu"));
  clear(HTML.query("#post-processing"));

  Object.keys(DATA.dictionaries).sort().forEach(function(dictionary) {
    addDictionary(dictionary, DATA.dictionaries[dictionary]);
  });

  DATA.sentences.sort().forEach(addSentence);
  DATA.postprocessing.forEach(addPostProcessingRule);

  HTML.query("#preview-seed").value = DATA.preview.seed;
  HTML.query("#preview-size").value = DATA.preview.size;
  HTML.query("#preview-overflow").checked = DATA.preview.overflow;
  HTML.query("#preview-separator").checked = DATA.preview.separator;

  HTML.query("#meta-title").value = DATA.meta.title;
  HTML.query("#meta-author").value = DATA.meta.author;
  HTML.query("#meta-description").value = DATA.meta.description;
};

var onDataChanged = function() {
  CHAT = { };
  onChatChange(null);
  redisplay();
  updatePreview();
  window.history.pushState(null, null, dataToUrl());
};

var parseDictionary = function(text) {
  var delimiter = "\n";
  if (text.indexOf("--8<--") >= 0) {
    delimiter = /\s*--8\<--\s*/;
    text = text.replace(/^\s*--8\<--\s*/, ""); // Remove first empty entry
  }
  var dictionary = text.split(delimiter).map(parseDictionaryEntry);
  if (dictionary.length > 0) {
    dictionary[0].delimiter = (delimiter === "\n") ? "\n" : "\n\n--8<--\n\n";
  }
  return dictionary;
}

addDictionary = function(name, entries) {
  var dictionary = HTML.query("#dictionaries").add("div");

  var input = dictionary.add("input");
  if (name) {
    input.value = name;
  }

  input.addEventListener('change', function(e) {
    var newName = e.target.value;
    while (DATA.dictionaries[newName]) {
      newName += "_dup";
    }
    DATA.dictionaries[newName] = DATA.dictionaries[name] || [ ];
    delete DATA.dictionaries[name];
    name = newName;

    onDataChanged();
  });

  var textarea = dictionary.add("textarea");
  if (entries) {
    var value = entries.map(function(entry) {
      var result = entry.value;
      if (entry.meta) {
        var meta = [ ];
        Object.keys(entry.meta).sort().forEach(function(key) {
          meta.push(key + "=" + entry.meta[key]);
        });
        if (meta.length > 0) {
          result += "#" + meta.join("&");
        }
      }
      return result;
    }).join(entries[0] && entries[0].delimiter || "\n");

    if (entries[0] && entries[0].delimiter && entries[0].delimiter !== "\n") {
      value = "--8<--\n\n" + value;
    }

    textarea.value = value;
  }

  setTimeout(function() {
    textarea.style.height = textarea.scrollHeight + "px";
  }, 50);

  textarea.addEventListener('change', function(e) {
    name = HTML.ify(e.target.parentNode).input.value;
    DATA.dictionaries[name] = parseDictionary(e.target.value);
    onDataChanged();
  });

  dictionary.add("button.remove{x}").addEventListener('click', function(e) {
    var div = HTML.ify(e.target.parentNode);
    delete DATA.dictionaries[div.input.value];
    div.remove();

    onDataChanged();
  });

  var editor = false;
  var fancyedit = dictionary.add("button.fancyedit{ACE}");
  fancyedit.addEventListener('click', function(e) {
    if (!editor) {
      editor = ace.edit(textarea);
      editor.$blockScrolling = Infinity;
      editor.setAutoScrollEditorIntoView(true);
      editor.setOption("maxLines", 30);
      editor.setOption("showInvisibles", true);
      editor.renderer.setShowPrintMargin(false);
      editor.getSession().setUseWrapMode(true);
      editor.getSession().setMode("ace/mode/storygen");
      editor.on("blur", function() {
        fancyedit.click(); // Hack
      });
      editor.focus();
      return;
    }

    name = HTML.ify(e.target.parentNode).input.value;
    DATA.dictionaries[name] = parseDictionary(editor.getSession().getValue());
    onDataChanged();
  });

  var menuItem = HTML.query("#hamburger-menu").add("div");
  menuItem.textContent = name;
  menuItem.addEventListener('click', function() {
    input.scrollIntoView();
  });
};

var rebuildSentences = function() {
  DATA.sentences = [ ];
  HTML.query("#sentences").all("div").all("textarea").each(
    function(textarea) {
      if (textarea.value) {
        DATA.sentences.push(textarea.value);
      }
    }
  );
};

addSentence = function(text) {
  var div = HTML.query("#sentences").add("div");

  var textarea = div.add("textarea");
  if (text) {
    textarea.value = text;
  }
  textarea.addEventListener('change', function() {
    rebuildSentences();
    onDataChanged();
  });

  setTimeout(function() {
    textarea.style.height = textarea.scrollHeight + "px";
  }, 50);

  div.add("button.remove{x}").addEventListener('click', function(e) {
    e.target.parentNode.remove();
    rebuildSentences();
    onDataChanged();
  });

  var editor = undefined;
  var fancyedit = div.add("button.fancyedit{ACE}");
  fancyedit.addEventListener('click', function(e) {
    if (!editor) {
      editor = ace.edit(textarea);
      editor.$blockScrolling = Infinity;
      editor.setAutoScrollEditorIntoView(true);
      editor.setOption("maxLines", 30);
      editor.setOption("showInvisibles", true);
      editor.renderer.setShowPrintMargin(false);
      editor.getSession().setUseWrapMode(true);
      editor.getSession().setMode("ace/mode/storygen");
      editor.on("blur", function() {
        fancyedit.click(); // Hack
      });
      editor.focus();
      return;
    }

    // Hack.
    var result = editor.getSession().getValue();
    editor.destroy();
    textarea = div.add("textarea");
    textarea.value = result;

    rebuildSentences();
    onDataChanged();
  });
};

var rebuildPostProcessingRules = function() {
  DATA.postprocessing = [ ];
  HTML.query("#post-processing").all("div").each(
    function(div) {
      DATA.postprocessing.push({
        find: div.query(".find").only(0).value,
        replace: div.query(".replace").only(0).value
      });
    }
  );
};

var addPostProcessingRule = function(rule) {
  rule = rule || { };

  var div = HTML.query("#post-processing").add("div");

  var find = div.add("input.find");
  find.addEventListener('change', function() {
    rebuildPostProcessingRules();
    onDataChanged();
  });
  find.value = rule.find || "";

  var replace = div.add("input.replace");
  replace.addEventListener('change', function() {
    rebuildPostProcessingRules();
    onDataChanged();
  });
  replace.value = rule.replace || "";

  div.add("button.remove{x}").addEventListener('click', function(e) {
    e.target.parentNode.remove();
    rebuildPostProcessingRules();
    onDataChanged();
  });
};

var reinit = function() {
  onDataChanged();
};

var shorten = function(done) {
  request
    .get('https://api-ssl.bitly.com/v3/shorten')
    .query({
      // TODO: NOT FOR PUBLISHING! PERSONAL AG'S TOKEN!
      access_token: '09fe0a4aa1f0c7ea14ec5f8d0952562b0ca87bea',
      format: 'txt',
      longUrl: window.location.href.replace(
        "localhost:8080/",
        "aagg.ru/upload/storygen/"
      )
    })
    .end(function(err, res) {
      if (err || !res.ok) {
        console.error("failed to get short url:", err, res);
        alert("Failed to get short URL:\n\n" + err);
        return;
      }
      done(res.text);
    });
};

var init = function() {
  HTML.query("#dictionaries + .add").addEventListener('click', function() {
    addDictionary();
  });
  HTML.query("#sentences + .add").addEventListener('click', function() {
    addSentence();
  });
  HTML.query("#post-processing + .add").addEventListener('click', function() {
    addPostProcessingRule();
  });

  HTML.query("#export").addEventListener('click', function() {
    var data = [ JSON.stringify({
      version: VERSION,
      payload: DATA
    }, null, "  ") ];

    var filename = "storygen.json";
    var properties = { type: 'application/json' };
    var blob = new Blob(data, properties);

    var url = window.URL.createObjectURL(blob);

    var a = document.createElement('a');
    a.style = "display: none";
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 100);
  });

  HTML.query("#import").addEventListener('change', function(e) {
    var reader = new window.FileReader();
    reader.onload = function(e) {
      UNSERIALIZE(e.target.result);
      reinit();
    };
    reader.readAsText(e.target.files[0]);
  });

  HTML.query("#reset").addEventListener('click', function() {
    DATA = DEFAULT_DATA();
    window.history.pushState(null, null, dataToUrl());
    window.location.reload(true);
  });

  HTML.query("#reset-to-chat").addEventListener('click', function() {
    DATA = CHAT_DATA();
    window.history.pushState(null, null, dataToUrl());
    window.location.reload();
  });

  HTML.query("#clear").addEventListener('click', function() {
    DATA = CLEAR_DATA();
    window.history.pushState(null, null, dataToUrl());
    window.location.reload();
  });

  HTML.query("#help").addEventListener('click', function() {
    HTML.query("#manual").classList.toggle("hidden");
  });

  HTML.query("#chat-toggle").addEventListener('click', function() {
    HTML.query("#chat").classList.toggle("hidden");
  });

  HTML.query("#preview-refresh").addEventListener('click', function() {
    DATA.preview.seed = new Chance().word();
    onDataChanged();
  });

  HTML.query("#preview-seed").addEventListener('change', function() {
    DATA.preview.seed = this.value;
    onDataChanged();
  });

  HTML.query("#preview-size").addEventListener('change', function() {
    DATA.preview.size = +this.value;
    onDataChanged();
  });

  HTML.query("#preview-overflow").addEventListener('change', function() {
    DATA.preview.overflow = !!this.checked;
    onDataChanged();
  });

  HTML.query("#preview-separator").addEventListener('change', function() {
    DATA.preview.separator = !!this.checked;
    onDataChanged();
  });

  HTML.query("#meta-title").addEventListener('change', function() {
    DATA.meta.title = this.value;
    onDataChanged();
  });

  HTML.query("#meta-author").addEventListener('change', function() {
    DATA.meta.author = this.value;
    onDataChanged();
  });

  HTML.query("#meta-description").addEventListener('change', function() {
    DATA.meta.description = this.value;
    onDataChanged();
  });

  HTML.query("#shorten").addEventListener('click', function() {
    shorten(function(url) { window.prompt("Short URL:", url); });
  });

  document.addEventListener('click', function(e) {
    if (e.target.id !== "hamburger-button") {
      HTML.query("#hamburger-menu").classList.add("hidden");
    }
  });

  HTML.query("#hamburger-button").addEventListener('click', function() {
    HTML.query("#hamburger-menu").classList.toggle("hidden");
  });

  window.addEventListener('hashchange', function() {
    var STORED;
    try {
      STORED = urlToData();
    } catch(e) {
      console.error("Failed to load data from url:", e);
      STORED = false;
    }

    if (STORED) {
      UNSERIALIZE(STORED);
    }

    if (!DATA) {
      DATA = DEFAULT_DATA();
    }
    CHAT = { };
    onChatChange(null);
    redisplay();
    updatePreview();
  });

  window.addEventListener('popstate', function() {
    var STORED;
    try {
      STORED = urlToData();
    } catch(e) {
      console.error("Failed to load data from url:", e);
      STORED = false;
    }

    if (STORED) {
      UNSERIALIZE(STORED);
    }

    if (!DATA) {
      DATA = DEFAULT_DATA();
    }
    CHAT = { };
    onChatChange(null);
    redisplay();
    updatePreview();
  });

  reinit();
};

document.addEventListener('DOMContentLoaded', init);
