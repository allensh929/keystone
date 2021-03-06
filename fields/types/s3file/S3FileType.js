/*!
 * Module dependencies.
 */

var _ = require('underscore'),
	moment = require('moment'),
	keystone = require('../../../'),
	async = require('async'),
	util = require('util'),
	knox = require('knox'),
	// s3 = require('s3'),
	utils = require('keystone-utils'),
	super_ = require('../Type');

/**
 * S3File FieldType Constructor
 * @extends Field
 * @api public
 */

function s3file(list, path, options) {

	this._underscoreMethods = ['format', 'uploadFile'];
	this._fixedSize = 'full';

	// event queues
	this._pre = {
		upload: []
	};

	// TODO: implement filtering, usage disabled for now
	options.nofilter = true;

	// TODO: implement initial form, usage disabled for now
	if (options.initial) {
		throw new Error('Invalid Configuration\n\n' +
			'S3File fields (' + list.key + '.' + path + ') do not currently support being used as initial fields.\n');
	}

	s3file.super_.call(this, list, path, options);

	// validate s3 config (has to happen after super_.call)
	if (!this.s3config) {
		throw new Error('Invalid Configuration\n\n' +
			'S3File fields (' + list.key + '.' + path + ') require the "s3 config" option to be set.\n\n' +
			'See http://keystonejs.com/docs/configuration/#services-amazons3 for more information.\n');
	}

	// Could be more pre- hooks, just upload for now
	if (options.pre && options.pre.upload) {
		this._pre.upload = this._pre.upload.concat(options.pre.upload);
	}

}

/*!
 * Inherit from Field
 */

util.inherits(s3file, super_);

/**
 * Exposes the custom or keystone s3 config settings
 */

Object.defineProperty(s3file.prototype, 's3config', { get: function() {
	return this.options.s3config || keystone.get('s3 config');
}});


/**
 * Allows you to add pre middleware after the field has been initialised
 *
 * @api public
 */

s3file.prototype.pre = function(event, fn) {
	if (!this._pre[event]) {
		throw new Error('S3File (' + this.list.key + '.' + this.path + ') error: s3field.pre()\n\n' +
			'Event ' + event + ' is not supported.\n');
	}
	this._pre[event].push(fn);
	return this;
};


/**
 * Registers the field on the List's Mongoose Schema.
 *
 * @api public
 */

s3file.prototype.addToSchema = function() {

	var field = this,
		schema = this.list.schema;

	var paths = this.paths = {
		// fields
		filename:		this._path.append('.filename'),
		path:			this._path.append('.path'),
		size:			this._path.append('.size'),
		filetype:		this._path.append('.filetype'),
		url:			this._path.append('.url'),
		// virtuals
		exists:			this._path.append('.exists'),
		upload:			this._path.append('_upload'),
		action:			this._path.append('_action')
	};

	var schemaPaths = this._path.addTo({}, {
		filename:		String,
		path:			String,
		size:			Number,
		filetype:		String,
		url:			String
	});

	schema.add(schemaPaths);

	var exists = function(item) {
		return (item.get(paths.url) ? true : false);
	};

	// The .exists virtual indicates whether a file is stored
	schema.virtual(paths.exists).get(function() {
		return schemaMethods.exists.apply(this);
	});

	var reset = function(item) {
		item.set(field.path, {
			filename: '',
			path: '',
			size: 0,
			filetype: '',
			url: ''
		});
	};

	var schemaMethods = {
		exists: function() {
			return exists(this);
		},
		/**
		 * Resets the value of the field
		 *
		 * @api public
		 */
		reset: function() {
			reset(this);
		},
		/**
		 * Deletes the file from S3File and resets the field
		 *
		 * @api public
		 */
		delete: function() {
			try {
				var client = knox.createClient(field.s3config);
				client.deleteFile(this.get(paths.path) + this.get(paths.filename), function(err, res){ return res ? res.resume() : false; });
			} catch(e) {}
			reset(this);
		}
	};

	_.each(schemaMethods, function(fn, key) {
		field.underscoreMethod(key, fn);
	});

	// expose a method on the field to call schema methods
	this.apply = function(item, method) {
		return schemaMethods[method].apply(item, Array.prototype.slice.call(arguments, 2));
	};

	this.bindUnderscoreMethods();
};


/**
 * Formats the field value
 *
 * @api public
 */

s3file.prototype.format = function(item) {
	if (this.hasFormatter()) {
		return this.options.format(item, item[this.path]);
	}
	return item.get(this.paths.url);
};


/**
 * Detects the field have formatter function
 *
 * @api public
 */

s3file.prototype.hasFormatter = function() {
	return 'function' === typeof this.options.format;
};


/**
 * Detects whether the field has been modified
 *
 * @api public
 */

s3file.prototype.isModified = function(item) {
	return item.isModified(this.paths.url);
};


/**
 * Validates that a value for this field has been provided in a data object
 *
 * @api public
 */

s3file.prototype.validateInput = function(data) {
	// TODO - how should file field input be validated?
	return true;
};


/**
 * Updates the value for this field in the item from a data object
 *
 * @api public
 */

s3file.prototype.updateItem = function(item, data) {
	// TODO - direct updating of data (not via upload)
};


/**
 * Uploads the file for this field
 *
 * @api public
 */

s3file.prototype.uploadFile = function(item, file, update, callback) {

	var field = this,
		path = field.options.s3path ? field.options.s3path + '/' : '',
		prefix = field.options.datePrefix ? moment().format(field.options.datePrefix) + '-' : '',
		filename = prefix + file.name,
		filetype = file.mimetype || file.type;

	if (field.options.allowedTypes && !_.contains(field.options.allowedTypes, filetype)) {
		return callback(new Error('Unsupported File Type: ' + filetype));
	}

	if ('function' === typeof update) {
		callback = update;
		update = false;
	}

	var doUpload = function() {

		if ('function' === typeof field.options.filename) {
			filename = field.options.filename(item, filename);
		}

		knox.createClient(field.s3config).putFile(file.path, path + filename, {
			'Content-Type': filetype,
			'x-amz-acl': 'public-read'
		}, function(err, res) {

			if (err) return callback(err);
			if (res) {
				if (res.statusCode !== 200) {
					return callback(new Error('Amazon returned Http Code: ' + res.statusCode));
				} else {
					res.resume();
				}
			}

			var protocol = (field.s3config.protocol && field.s3config.protocol + ':') || '',
				url = res.req.url.replace(/^https?:/i, protocol);

			var fileData = {
				filename: filename,
				path: path,
				size: file.size,
				filetype: filetype,
				url: url
			};

			if (update) {
				item.set(field.path, fileData);
			}

			callback(null, fileData);

		});
	};

	async.eachSeries(this._pre.upload, function(fn, next) {
		fn(item, file, next);
	}, function(err) {
		if (err) return callback(err);
		doUpload();
	});

};


/**
 * Returns a callback that handles a standard form submission for the field
 *
 * Expected form parts are
 * - `field.paths.action` in `req.body` (`clear` or `delete`)
 * - `field.paths.upload` in `req.files` (uploads the file to s3file)
 *
 * @api public
 */

s3file.prototype.getRequestHandler = function(item, req, paths, callback) {

	var field = this;

	if (utils.isFunction(paths)) {
		callback = paths;
		paths = field.paths;
	} else if (!paths) {
		paths = field.paths;
	}

	callback = callback || function() {};

	return function() {

		if (req.body) {
			var action = req.body[paths.action];

			if (/^(delete|reset)$/.test(action))
				field.apply(item, action);
		}

		if (req.files && req.files[paths.upload] && req.files[paths.upload].size) {
			return field.uploadFile(item, req.files[paths.upload], true, callback);
		}

		return callback();

	};

};


/**
 * Immediately handles a standard form submission for the field (see `getRequestHandler()`)
 *
 * @api public
 */

s3file.prototype.handleRequest = function(item, req, paths, callback) {
	this.getRequestHandler(item, req, paths, callback)();
};


/*!
 * Export class
 */

exports = module.exports = s3file;
