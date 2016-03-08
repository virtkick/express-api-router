'use strict';

let express = require('express');
let methods = require('methods');
let Promise = require('bluebird');

function resolveNestedPromises(obj) {
  return Promise.resolve(obj).then(obj => {
    if(Array.isArray(obj)) {
      return Promise.map(obj, resolveNestedPromises);
    }
    else if(typeof obj === 'object') {
      let promisesToResolve = [];
      Object.keys(obj).map(key => {
        let promise = resolveNestedPromises(obj[key]).then(val=> {
          obj[key] = val;
        });
        promisesToResolve.push(promise)
      });
      if(promisesToResolve.length) {
        return Promise.all(promisesToResolve).then(() => obj);
      }
    }
    return obj;
  });
}

class ExpressApiRouterError extends Error {
  constructor(message) {
    super(message);
    this.message = message;
    this.name = 'ExpressApiRouterError';
  }
}

class ApiError extends Error {
  constructor(data, statusCode) {
    super(data);
    this.message = data;
    this.statusCode = statusCode;
    this.name = 'ApiError';
  }
}

class ExpressApiRouter extends express.Router {
  constructor(options) {
    super(options);
    this.options = options || {};
    let self = this;
    
    let silenceExpressApiRouterError = options.silenceExpressApiRouterError;

    this.setErrorFormatter = formatter => {
      this.options.errorFormatter = formatter;
    };
            
    methods.forEach(method => {
      let oldImplementation = this[method];
      this[method] = function(path) {
        let callbacks = Array.prototype.slice.call(arguments, 1);
        
        callbacks = callbacks.map((origHandler, index) => {
          return (req, res, next) => {
            let returnValue = origHandler(req, res, next);
            
            let apiErrorHandler = err => {
              res.status(err.statusCode || 500).json(err.message);
              return Promise.resolve();
            };
            
            Promise.resolve().then(() => {
              if(typeof returnValue === 'undefined' && index === callbacks.length - 1) {
                throw new ExpressApiRouterError('Route for ' + path.toString() + ' did not return a promise');
              }
              return Promise.resolve(returnValue);
            })
            .then(resolveNestedPromises)
            .then(value => {
              if(res._header) {
                throw new ExpressApiRouterError('Route for ' + path.toString() + ' returned a promise but headers were already sent by the time it was resolved');
              }
              
              if(typeof value === 'object') {
                return res.json(value);
              }
              if(typeof value === 'string') {
                return res.send(value);
              }
            }).catch(ExpressApiRouterError, err => {
              res.emit('expressApiRouterError', err);
              if(!silenceExpressApiRouterError) {
                console.error(err.stack);
              }
            })
            .catch(ApiError, apiErrorHandler)
            .catch(err => {
              let formatError = err => {
                if(this.options.errorFormatter) {
                  return Promise.resolve().then(() => this.options.errorFormatter(err, req, res));
                }
                return Promise.resolve();
              };
              
              return formatError(err).then(jsonError => {
                res.status(500).json(jsonError || this.options.internalServerError
                    || {error: 'Internal server error'});
                if(!jsonError) { // rethrow only not-formatted errors
                  throw err;
                }
              })
              // support re-thrown ApiError from error formatter
              .catch(ApiError, apiErrorHandler);
            });
          };
        });
        oldImplementation.apply(this, [path].concat(callbacks));
      };
    });
  }
};

module.exports = ExpressApiRouter;
module.exports.ApiError = ApiError;