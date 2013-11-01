(function(context) {

  var Lazy = context.Lazy;

  // Auto-require Lazy if it isn't already defined and we're in Node.
  if (typeof Lazy === 'undefined' && typeof require === 'function') {
    Lazy = require('lazy.js');
  }

  // Define a custom type of sequence that recursively walks the nodes of an
  // AST.
  Lazy.Sequence.define('nodes', {
    each: function(fn) {
      var self = this;

      self.parent.each(function(node) {
        if (fn(node) === false) {
          return false;
        }

        var children = self.getNodeChildren(node);

        if (children.length > 0) {
          // Give each child a reference to its parent.
          Lazy(children).each(function(child) {
            child.parent = node;
          });

          return Lazy(children).nodes().each(fn);
        }
      });
    },

    getNodeChildren: function(node) {
      switch (node.type) {
        case 'FunctionDeclaration':
        case 'FunctionExpression':
          return [node.body];

        case 'BlockStatement':
          return node.body;

        case 'ExpressionStatement':
          return [node.expression];

        case 'AssignmentExpression':
          return [node.right];

        case 'CallExpression':
          return node.callee.type === 'FunctionExpression' ? [node.callee] : [];

        case 'ObjectExpression':
          return node.properties;

        case 'Property':
          return [node.key, node.value];

        case 'VariableDeclaration':
          return node.declarations;

        case 'VariableDeclarator':
          return [node.init];

        // Throw these away:
        case 'Identifier':
        case 'EmptyStatement':
        case 'ReturnStatement':
          return [];

        default:
          throw 'Unknown node type "' + node.type + '" - ' +
            'Report this to https://github.com/dtao/autodoc/issues';
      }
    }
  });

  /**
   * @typedef {Object} Parser
   * @property {function(string):*} parse
   */

  /**
   * @typedef {Object} ExampleHandler
   * @property {RegExp} pattern
   * @property {function(Array.<string>, *):*} test
   */

  /**
   * @typedef {Object} TemplateEngine
   * @property {function(string, Object):string} render
   */

  /**
   * @typedef {Object} AutodocOptions
   * @property {Parser|function(string):*} codeParser
   * @property {Parser|function(string):*} commentParser
   * @property {Parser|function(string):*} markdownParser
   * @property {Array.<string>} namespaces
   * @property {Array.<string>} tags
   * @property {Array.<string>} javascripts
   * @property {string} template
   * @property {TemplateEngine} templateEngine
   * @property {Array.<ExampleHandler>} exampleHandlers
   * @property {Object} extraOptions
   */

  /**
   * @constructor
   * @param {AutodocOptions=} options
   */
  function Autodoc(options) {
    options = Lazy(options || {})
      .defaults(Autodoc.options)
      .toObject();

    this.codeParser      = wrapParser(options.codeParser);
    this.commentParser   = wrapParser(options.commentParser);
    this.markdownParser  = wrapParser(options.markdownParser, Autodoc.processInternalLinks);
    this.namespaces      = options.namespaces || [];
    this.tags            = options.tags || [];
    this.javascripts     = options.javascripts || [];
    this.exampleHandlers = options.exampleHandlers || [];
    this.template        = options.template;
    this.templateEngine  = options.templateEngine;
    this.extraOptions    = options.extraOptions || {};
  }

  Autodoc.VERSION = '0.2.2';

  /**
   * Default Autodoc options. (See autodoc-node.js)
   */
  Autodoc.options = {};

  /**
   * @typedef {Object} LibraryInfo
   * @property {string} name
   * @property {string} referenceName
   * @property {string} description
   * @property {string} code
   * @property {Array.<NamespaceInfo>} namespaces
   */

  /**
   * Creates a Autodoc instance with the specified options and uses it to
   * parse the given code.
   *
   * @param {string} code The JavaScript code to parse.
   * @param {AutodocOptions=} options
   * @returns {LibraryInfo}
   */
  Autodoc.parse = function(code, options) {
    return new Autodoc(options).parse(code);
  };

  /**
   * Creates a Autodoc instance with the specified options and uses it to
   * generate HTML documentation from the given code.
   *
   * @param {LibraryInfo|string} source Either the already-parsed library data
   *     (from calling {@link #parse}), or the raw source code.
   * @param {AutodocOptions} options
   * @returns {string} The HTML for the library's API docs.
   */
  Autodoc.generate = function(source, options) {
    return new Autodoc(options).generate(source);
  };

  /**
   * Parses an arbitrary blob of JavaScript code and returns an object
   * containing all of the data necessary to generate a project website with
   * docs, specs, and performance benchmarks.
   *
   * @param {string} code The JavaScript code to parse.
   * @returns {LibraryInfo}
   */
  Autodoc.prototype.parse = function(code) {
    var autodoc = this;

    // Generate the abstract syntax tree.
    var ast = this.codeParser.parse(code, {
      comment: true,
      loc: true
    });

    // This is kind of stupid... for now, I'm just assuming the library will
    // have a @fileOverview tag and @name tag in the header comments.
    var librarySummary = autodoc.getLibrarySummary(ast.comments);

    // Extract all of the functions from the AST, and map them to their location
    // in the code (this is so that we can associate each function with its
    // accompanying doc comments, if any).
    var functions = Lazy(ast.body).nodes()
      .filter(function(node) {
        return node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression';
      })
      .groupBy(function(node) { return node.loc.start.line; })
      .toObject();

    // Go through all of of the comments in the AST, attempting to associate
    // each with a function.
    var docs = Lazy(ast.comments)
      .map(function(comment) {
        // Find the function right after this comment. If none exists, skip it.
        var fn = functions[comment.loc.end.line + 1];
        if (typeof fn === 'undefined') {
          return null;
        }

        // Attempt to parse the comment. If it can't be parsed, or it appears to
        // be basically empty, then skip it.
        var doc = autodoc.parseComment(comment);
        if (typeof doc === 'undefined' || !doc.description) {
          return null;
        }

        return autodoc.createFunctionInfo(fn, doc);
      })
      .compact();

    // If no tags have been explicitly provided, but we find any occurrences of
    // the @public tag, we'll use that as a hint that only those methods tagged
    // @public should be included. Otherwise include everything.
    if (this.tags.length === 0) {
      if (docs.any(function(doc) { return doc.isPublic; })) {
        this.tags.push('public');
      }
    }

    // Only include documentation for functions with the specified tag(s), if
    // provided.
    if (this.tags.length > 0) {
      docs = docs.filter(function(doc) {
        return Lazy(autodoc.tags).any(function(tag) {
          return Lazy(doc.tags).contains(tag);
        });
      });
    }

    // Provide a flat list of all docs to make it easier to, e.g., apply some
    // logic to every doclet in the library.
    var docList = docs.toArray();

    // Also group by namespace so that we can keep the docs organized.
    var docGroups = Lazy(docList)
      .groupBy(function(doc) {
        return doc.namespace || doc.shortName;
      })
      .toObject();

    // Only include specified namespaces, if the option has been provided.
    // Otherwise use all namespaces.
    if (this.namespaces.length === 0) {
      this.namespaces = Object.keys(docGroups);
    }

    var namespaces = Lazy(this.namespaces)
      .map(function(namespace) {
        return Autodoc.createNamespaceInfo(docGroups, namespace);
      })
      .toArray();

    // We'll guess that the first "namespace" that actually has members is
    // probably the conventional "name" of the library (i.e., the variable one
    // would typically use to hold a reference to it -- like _ for Underscore,
    // $ for jQuery, and so on).
    var firstNonEmptyNamespace = Lazy(namespaces)
      .find(function(namespace) {
        return namespace.members.length > 0;
      });

    var referenceName = firstNonEmptyNamespace ?
      firstNonEmptyNamespace.namespace.split('.').shift() :
      null;

    // TODO: Make this code a little more agnostic about the whole namespace
    // thing. I'm pretty sure there are plenty of libraries that don't use
    // this pattern at all.
    return {
      name: librarySummary.name || referenceName,
      referenceName: referenceName,
      description: librarySummary.description,
      code: code,
      namespaces: namespaces,
      docs: docList
    };
  };

  /**
   * Generates HTML for the API docs for the given library (as raw source code)
   * using the specified options, including templating library.
   *
   * @param {LibraryInfo|string} source Either the already-parsed library data
   *     (from calling {@link #parse}), or the raw source code.
   * @returns {string} The HTML for the library's API docs.
   */
  Autodoc.prototype.generate = function(source) {
    var libraryInfo = typeof source === 'string' ?
      this.parse(source) :
      source;

    // Decorate examples w/ custom handlers so that the template can be
    // populated differently for them.
    this.updateExamples(libraryInfo);

    // Additional stuff we want to tack on.
    libraryInfo.javascripts = this.javascripts;

    // Allow for arbitrary additional options, e.g. if the user wants to use
    // a custom template.
    var templateData = Lazy(libraryInfo)
      .extend(this.extraOptions)
      .toObject();

    // Finally pass our awesomely-finessed data to the template engine,
    // e.g., Mustache.
    return this.templateEngine.render(this.template, templateData);
  };

  /**
   * Iterates over all of the examples in the library and applies a callback to
   * each, along with its associated function name.
   *
   * @param {LibraryInfo} libraryInfo
   * @param {function(ExampleInfo, string):*} callback
   */
  Autodoc.prototype.eachExample = function(libraryInfo, callback) {
    Lazy(libraryInfo.docs)
      .each(function(doc) {
        Lazy(doc.examples.list).each(function(example) {
          callback(example, doc.name);
        });
      });
  };

  /**
   * Iterates over all of the examples in the library and tests whether each
   * should be handled by a custom handler. If so, marks it as such for
   * consumption by e.g. a template or a test runner.
   *
   * @param {LibraryInfo} libraryInfo
   */
  Autodoc.prototype.updateExamples = function(libraryInfo) {
    // Allow a library to provide a config.js file, which should define an array
    // of handlers like:
    //
    // [
    //   { pattern: /regex/, test: function(match, actual) },
    //   { pattern: /regex/, test: function(match, actual) },
    //   ...
    // ]
    //
    var exampleHandlers = this.exampleHandlers;
    if (exampleHandlers.length === 0) {
      return;
    }

    this.eachExample(libraryInfo, function(example) {
      // Look at all of our examples. Those that are matched by some handler, we
      // will leave to be verified by handler.test, which will obviously need to
      // be available in the output HTML (bin/autodoc ensures this).
      Lazy(exampleHandlers).each(function(handler, i) {
        if (handler.pattern.test(example.output)) {
          // Mark this example as being handled
          example.hasCustomHandler = true;
          example.handlerIndex = i;

          // Force output to look like a string, so we can dump it in the
          // middle of a <script> tag without a syntax error.
          example.outputPattern = JSON.stringify(example.output);

          // Exit early -- we found our handler!
          return false;
        }
      });
    });
  };

  /**
   * @typedef {Object} FunctionInfo
   * @property {string} name
   * @property {string} description
   * @property {boolean} isConstructor
   * @property {boolean} isStatic
   * @property {boolean} isPublic
   * @property {boolean} hasExamples
   * @property {boolean} hasBenchmarks
   * @property {Array.<ParameterInfo>} params
   * @property {Array.<ReturnInfo>} returns
   * @property {ExampleCollection} examples
   * @property {BenchmarkCollection} benchmarks
   * @property {Array.<string>} tags
   */

  /**
   * Takes a function node from the AST along with its associated doclet (from
   * parsing its comments) and generates an object with boatloads of data on it,
   * useful for passing to a templating system such as Mustache.
   *
   * @param {Object} fn
   * @param {Object} doc
   * @returns {FunctionInfo}
   */
  Autodoc.prototype.createFunctionInfo = function(fn, doc) {
    var nameInfo    = Autodoc.parseName(Autodoc.getIdentifierName(fn[0])),
        description = this.markdownParser.parse(doc.description),
        params      = this.getParams(doc),
        returns     = this.getReturns(doc),
        isCtor      = Autodoc.hasTag(doc, 'constructor'),
        isStatic    = nameInfo.name.indexOf('#') === -1, // That's right, hacky smacky
        isPublic    = Autodoc.hasTag(doc, 'public'),
        signature   = Autodoc.getSignature(nameInfo, params),
        examples    = Autodoc.getExamples(doc),
        benchmarks  = Autodoc.getBenchmarks(doc),
        tags        = Lazy(doc.tags).pluck('title').toArray();

    return {
      name: nameInfo.name,
      shortName: nameInfo.shortName,
      identifier: nameInfo.identifier,
      namespace: nameInfo.namespace,
      description: description,
      params: params,
      returns: returns,
      isConstructor: isCtor,
      isStatic: isStatic,
      isPublic: isPublic,
      hasSignature: params.length > 0 || !!returns,
      signature: signature,
      examples: examples,
      hasExamples: examples.list.length > 0,
      benchmarks: benchmarks,
      hasBenchmarks: benchmarks.list.length > 0,
      tags: tags
    };
  };

  /**
   * @typedef {Object} ParameterInfo
   * @property {string} name
   * @property {string} type
   * @property {string} description
   */

  /**
   * Gets an array of { name, type, description } objects representing the
   * parameters of a function definition.
   *
   * @param {Object} doc The doclet for the function.
   * @returns {Array.<ParameterInfo>} An array of { name, type, description }
   *     objects.
   */
  Autodoc.prototype.getParams = function(doc) {
    var markdownParser = this.markdownParser;

    return Lazy(doc.tags)
      .where({ title: 'param' })
      .map(function(tag) {
        return {
          name: tag.name,
          type: Autodoc.formatType(tag.type),
          description: markdownParser.parse(tag.description || '')
        };
      })
      .toArray();
  };

  /**
   * @typedef {Object} ReturnInfo
   * @property {string} type
   * @property {string} description
   */

  /**
   * Get a { type, description } object representing the return value of a
   * function definition.
   *
   * @param {Object} doc The doclet for the function.
   * @returns {ReturnInfo} A { type, description } object.
   */
  Autodoc.prototype.getReturns = function(doc) {
    var returnTag = Lazy(doc.tags).findWhere({ title: 'returns' });

    if (typeof returnTag === 'undefined') {
      return null;
    }

    return {
      type: Autodoc.formatType(returnTag.type),
      description: this.markdownParser.parse(returnTag.description || '')
    };
  };

  /**
   * @typedef LibrarySummary
   * @property {string} name
   * @property {string} description
   */

  /**
   * Returns a { name, description } object describing an entire library.
   *
   * @param {Array.<string>} comments
   * @returns {LibrarySummary}
   */
  Autodoc.prototype.getLibrarySummary = function(comments) {
    var autodoc = this;

    var docWithFileOverview = Lazy(comments)
      .map(function(comment) {
        return autodoc.parseComment(comment);
      })
      .compact()
      .filter(function(doc) {
        return Lazy(doc.tags).where({ title: 'fileOverview' }).any();
      })
      .first();

    var libraryName = '',
        libraryDesc = '';

    if (docWithFileOverview) {
      libraryDesc = Lazy(docWithFileOverview.tags).findWhere({ title: 'fileOverview' }).description;

      var libraryNameTag = Lazy(docWithFileOverview.tags).findWhere({ title: 'name' });
      if (libraryNameTag) {
        libraryName = libraryNameTag.description;
      }
    }

    return {
      name: libraryName,
      description: this.markdownParser.parse(libraryDesc)
    };
  };

  /**
   * Parses a comment.
   *
   * @param {string} comment The comment to parse.
   * @returns {Object}
   */
  Autodoc.prototype.parseComment = function(comment) {
    return this.commentParser.parse('/*' + comment.value + '*/', { unwrap: true });
  };

  /**
   * Gets the name of whatever identifier is associated with this node (if any).
   *
   * @param {Object} object
   * @return {Object}
   */
  Autodoc.getIdentifierName = function(node) {
    if (!node) {
      return null;
    }

    switch (node.type) {
      case 'Identifier':
        return node.name;

      case 'FunctionDeclaration':
        return Autodoc.getIdentifierName(node.id);

      case 'AssignmentExpression':
        return Autodoc.getIdentifierName(node.left);

      case 'MemberExpression':
        return (Autodoc.getIdentifierName(node.object) + '.' +
          Autodoc.getIdentifierName(node.property)).replace(/\.prototype\./, '#');

      case 'Property':
        return Autodoc.getIdentifierName(node.parent) + '.' +
          Autodoc.getIdentifierName(node.key);

      case 'FunctionExpression':
        return Autodoc.getIdentifierName(node.parent);

      case 'VariableDeclarator':
        return Autodoc.getIdentifierName(node.id);

      case 'ExpressionStatement':
        return Autodoc.getIdentifierName(node.expression);

      default:
        return Autodoc.getIdentifierName(node.parent);
    }
  };

  /**
   * @typedef {Object} NameInfo
   * @property {string} name
   * @property {string} shortName
   * @property {string} namespace
   * @property {string} identifier
   */

  /**
   * Takes, e.g., 'Foo#bar' and returns { name: 'Foo#bar', shortName: 'bar' }
   *
   * @public
   * @param {string} name
   * @returns {NameInfo}
   *
   * @examples
   * Autodoc.parseName('Foo#bar').name           // => 'Foo#bar'
   * Autodoc.parseName('Foo#bar').shortName      // => 'bar'
   * Autodoc.parseName('Foo.Bar#baz').namespace  // => 'Foo.Bar'
   * Autodoc.parseName('Foo#bar').identifier     // => 'Foo-bar'
   * Autodoc.parseName('Foo.Bar#baz').identifier // => 'Foo-Bar-baz'
   * Autodoc.parseName('Foo').name               // => 'Foo'
   * Autodoc.parseName('Foo').identifier         // => 'Foo'
   * Autodoc.parseName('Foo').namespace          // => null
   */
  Autodoc.parseName = function(name) {
    var parts = name.split(/[\.#]/),

        // e.g., the short name for 'Lib.utils.func' should be 'func'
        shortName = parts.pop(),

        // a name like 'foo#bar#baz' wouldn't make sense; so we can safely join
        // w/ '.' to recreate the namespace
        namespace = parts.join('.');

    return {
      name: name,
      shortName: shortName,
      namespace: namespace || null,
      identifier: name.replace(/[\.#]/g, '-')
    };
  };

  /**
   * Simply determines whether a doc has a tag or doesn't.
   *
   * @public
   * @param {Object} doc The doclet to check.
   * @param {string} tagName The tag name to look for.
   * @returns {boolean} Whether or not the doclet has the tag.
   */
  Autodoc.hasTag = function(doc, tagName) {
    return !!Lazy(doc.tags).findWhere({ title: tagName });
  };

  /**
   * Produces a string representing the signature of a function.
   *
   * @param {NameInfo} name
   * @param {Array.<ParameterInfo>} params
   * @returns {string}
   */
  Autodoc.getSignature = function(name, params) {
    var formattedParams = '(' + Lazy(params).pluck('name').join(', ') + ')';

    if (name.name === name.shortName) {
      return 'function ' + name.shortName + formattedParams;
    } else {
      return name.namespace + '.' + name.shortName + ' = function' + formattedParams;
    }
  };

  /**
   * @typedef PairInfo
   * @property {string} left
   * @property {string} right
   */

  /**
   * @callback DataCallback
   * @param {{preamble:string, pairs:Array.<PairInfo>}} data
   * @returns {*}
   */

  /**
   * Takes a doclet and a tag name, then reads all of the lines from that tag
   * and splits them across '=>', finally calling a callback on each left/right
   * pair. (Does that make any sense? Whatever.)
   *
   * @param {Object} doc
   * @param {string} tagName
   * @param {DataCallback} callback
   * @returns {Array.<*>} An array of whatever the callback returns.
   */
  Autodoc.parseCommentLines = function(doc, tagName, callback) {
    var comment      = Autodoc.getTagDescription(doc, tagName),
        commentLines = comment.split('\n'),
        initialLines = [],
        pairs        = [];

    Lazy(commentLines)
      .each(function(line) {
        var pair = Autodoc.parsePair(line);

        if (!pair && pairs.length === 0) {
          initialLines.push(line);

        } else if (pair) {
          pairs.push(pair);
        }
      });

    return callback({
      content: comment,
      preamble: initialLines.join('\n'),
      pairs: pairs
    });
  };

  /**
   * Gets the text from a given comment tag.
   *
   * @param {Object} doc
   * @param {string} tagName
   * @returns {string}
   */
  Autodoc.getTagDescription = function(doc, tagName) {
    var tag = Lazy(doc.tags).findWhere({ title: tagName });

    if (typeof tag === 'undefined') {
      return '';
    }

    return tag.description;
  };

  /**
   * Given a line like 'input // => output', parses this into a { left, right }
   * pair. Trims leading and trailing whitespace around both parts. The '=>'
   * part is optional.
   *
   * @public
   * @param {string} line
   * @returns {PairInfo|null}
   *
   * @examples
   * Autodoc.parsePair('foo(bar)//=>5')      // => { left: 'foo(bar)', right: '5' }
   * Autodoc.parsePair(' bar(baz) //=> 10 ') // => { left: 'bar(baz)', right: '10' }
   * Autodoc.parsePair('foo // => bar')      // => { left: 'foo', right: 'bar' }
   * Autodoc.parsePair('foo // bar')         // => { left: 'foo', right: 'bar' }
   */
  Autodoc.parsePair = function(line) {
    var parts = line.match(/^(.*)\s*\/\/[ ]*(?:=>)?\s*(.*)$/);

    if (!parts) {
      return null;
    }

    return {
      left: Autodoc.trim(parts[1]),
      right: Autodoc.trim(parts[2])
    };
  };

  /**
   * @typedef {Object} ExampleInfo
   * @property {number} id
   * @property {string} input
   * @property {string} inputForJs
   * @property {string} output
   * @property {string} outputForJs
   */

  /**
   * @typedef {Object} ExampleCollection
   * @property {string} code
   * @property {string} setup
   * @property {Array.<ExampleInfo>} list
   */

  /**
   * Produces a { setup, examples } object providing some examples of a function.
   *
   * @param {Object} doc
   * @returns {ExampleCollection}
   */
  Autodoc.getExamples = function(doc) {
    var exampleIdCounter = 1;
    return Autodoc.parseCommentLines(doc, 'examples', function(data) {
      return {
        code: data.content,
        setup: data.preamble,
        list: Lazy(data.pairs).map(function(pair) {
          return {
            id: exampleIdCounter++,
            input: pair.left,
            inputForJs: Autodoc.escapeForJs(pair.left),
            output: pair.right,
            outputForJs: Autodoc.escapeForJs(pair.right)
          };
        }).toArray()
      };
    });
  };

  /**
   * @typedef {Object} BenchmarkCase
   * @property {number} caseId
   * @property {string} impl
   * @property {string} name
   * @property {string} label
   */

  /**
   * @typedef {Object} BenchmarkInfo
   * @property {number} id
   * @property {string} name
   * @property {Array.<BenchmarkCase>} cases
   */

  /**
   * @typedef {Object} BenchmarkCollection
   * @property {string} code
   * @property {string} setup
   * @property {Array.<BenchmarkInfo>} list
   */

  /**
   * Produces a { setup, benchmarks } object providing some benchmarks for a function.
   *
   * @param {Object} doc
   * @returns {BenchmarkCollection}
   */
  Autodoc.getBenchmarks = function(doc) {
    var benchmarkCaseIdCounter = 1,
        benchmarkIdCounter     = 1;

    return Autodoc.parseCommentLines(doc, 'benchmarks', function(data) {
      var benchmarks = Lazy(data.pairs)
        .map(function(pair) {
          var parts = Autodoc.divide(pair.right, ' - ');

          return {
            caseId: benchmarkCaseIdCounter++,
            impl: pair.left,
            name: parts[0],
            label: parts[1] || 'Ops/second'
          };
        })
        .groupBy('name')
        .map(function(group) {
          return {
            id: benchmarkIdCounter++,
            name: group[0],
            cases: group[1]
          }
        })
        .toArray();

      return {
        code: data.content,
        setup: data.preamble,
        list: benchmarks,
        cases: benchmarks.length > 0 ? benchmarks[0].cases : []
      };
    });
  };

  /**
   * Produces a string representation of a type object.
   *
   * @param {Object} type
   * @returns {string}
   */
  Autodoc.formatType = function(type) {
    switch (type.type) {
      case 'NameExpression':
        return type.name;

      case 'AllLiteral':
        return '*';

      case 'NullLiteral':
        return 'null';

      case 'TypeApplication':
        return Autodoc.formatType(type.expression) + '.<' + Lazy(type.applications).map(Autodoc.formatType).join('|') + '>';

      case 'RecordType':
        return '{' + Lazy(type.fields).map(function(field) {
          return field.key + ':' + Autodoc.formatType(field.value);
        }).join(', ');

      case 'OptionalType':
        return Autodoc.formatType(type.expression) + '?';

      case 'UnionType':
        return Lazy(type.elements).map(Autodoc.formatType).join('|');

      case 'RestType':
        return '...' + Autodoc.formatType(type.expression);

      case 'FunctionType':
        return 'function(' + Lazy(type.params).map(Autodoc.formatType).join(', ') + '):' + Autodoc.formatType(type.result);

      default:
        throw 'Unable to format type ' + type.type + '!\n\n' + JSON.stringify(type, null, 2);
    }
  };

  /**
   * @typedef {Object} NamespaceInfo
   * @property {string} namespace
   * @property {FunctionInfo} constructorMethod
   * @property {Array.<FunctionInfo>} members
   * @property {Array.<FunctionInfo>} allMembers
   * @property {boolean} hasExamples
   * @property {boolean} hasBenchmarks
   */

  /**
   * Finds all of the functions in a library belonging to a certain namespace
   * and creates a { namespace, constructorMethod, members, allMembers } object
   * from each, with members sorted in a UI-friendly order.
   *
   * @param {Object.<string, Array.<FunctionInfo>>} docs
   * @param {string} namespace
   * @returns {NamespaceInfo}
   */
  Autodoc.createNamespaceInfo = function(docs, namespace) {
    // Find the corresponding constructor, if one exists.
    var constructorMethod = Lazy(docs)
      .values()
      .flatten()
      .findWhere({ name: namespace });

    // Get all the members that are part of the specified namespace, excluding
    // the constructor (if applicable), and sort them alphabetically w/ so-called
    // "static" members coming first.
    var members = Lazy(docs[namespace])
      .reject(function(doc) {
        return doc.name === namespace;
      })
      .sortBy(function(doc) {
        // Talk about hacky...
        // This is how I've decided to put static methods first.
        return (doc.isStatic ? 'a' : 'b') + doc.shortName;
      })
      .toArray();

    // For templating purposes, it will also be useful to have a collection
    // comprising ALL members, in this order:
    //
    // 1. constructor
    // 2. static methods
    // 3. instance methods
    var allMembers = Lazy([constructorMethod])
      .concat(members)
      .compact()
      .toArray();

    // Decorate these docs w/ a meaningful "type" (this is more useful than just
    // a boolean flag, and it's easier to do here than in the template).
    Lazy(allMembers).each(function(member) {
      member.sectionType = member.isConstructor ? 'constructor' : 'method';
    });

    return {
      namespace: namespace,
      constructorMethod: constructorMethod,
      members: members,
      allMembers: allMembers,
      hasExamples: Lazy(allMembers).any(function(m) { return m.hasExamples; }),
      hasBenchmarks: Lazy(allMembers).any(function(m) { return m.hasBenchmarks; }),
    };
  };

  /**
   * Provides an escaped form of a string to facilitate dropping it "unescaped"
   * (aside from this, of course) directly into a JS template.
   *
   * @public
   * @param {string} string
   * @returns {string}
   *
   * @examples
   * Autodoc.escapeForJs('foo')            // => 'foo'
   * Autodoc.escapeForJs("Hell's Kitchen") // => "Hell\\'s Kitchen"
   */
  Autodoc.escapeForJs = function(string) {
    return string.replace(/'/g, "\\'");
  };

  /**
   * Replaces JsDoc references like '{@link MyClass}' with actual HTML links.
   *
   * @public
   * @param {string} html
   * @returns {string} The HTML with JsDoc `@link` references replaced by links.
   *
   * @examples
   * Autodoc.processInternalLinks('{@link MyClass}') // => '<a href="#MyClass">MyClass</a>'
   */
  Autodoc.processInternalLinks = function(html) {
    return html.replace(/\{@link ([^\}]*)}/g, function(string, match) {
      return '<a href="#' + match.replace(/[\.#]/g, '-') + '">' + match + '</a>';
    });
  };

  /**
   * Removes leading and trailing whitespace from a string.
   *
   * @public
   * @param {string} string The string to trim.
   * @returns {string} The trimmed result.
   *
   * @examples
   * Autodoc.trim('foo')     // => 'foo'
   * Autodoc.trim('  foo')   // => 'foo'
   * Autodoc.trim('foo  ')   // => 'foo'
   * Autodoc.trim('  foo  ') // => 'foo'
   */
  Autodoc.trim = function(string) {
    return string.replace(/^\s+/, '').replace(/\s+$/, '');
  };

  /**
   * Splits a string into two parts on either side of a specified divider.
   *
   * @public
   * @param {string} string The string to divide into two parts.
   * @param {string} divider The string used as the pivot point.
   * @returns {Array.<string>} The parts of the string before and after the
   *     first occurrence of `divider`, or a 1-element array containing `string`
   *     if `divider` wasn't found.
   *
   * @examples
   * Autodoc.divide('hello', 'll')   // => ['he', 'o']
   * Autodoc.divide('banana', 'n')   // => ['ba', 'ana']
   * Autodoc.divide('a->b->c', '->') // => ['a', 'b->c']
   * Autodoc.divide('foo', 'xyz')    // => ['foo']
   * Autodoc.divide('abc', 'abc')    // => ['', '']
   */
  Autodoc.divide = function(string, divider) {
    var seam = string.indexOf(divider);
    if (seam === -1) {
      return [string];
    }

    return [string.substring(0, seam), string.substring(seam + divider.length)];
  };

  /**
   * Takes either a `{ parse }` object or an actual function and wraps it as a
   * `{ parse }` object with an optional post-processing step.
   */
  function wrapParser(parser, postprocess) {
    if (!parser) {
      return null;
    }

    postprocess = postprocess || Lazy.identity;

    var parseMethod = typeof parser === 'function' ?
      parser :
      parser.parse;

    return {
      parse: function() {
        return postprocess(parseMethod.apply(parser, arguments));
      }
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Autodoc;

  } else {
    context.Autodoc = Autodoc;
  }

}(typeof global !== 'undefined' ? global : this));
