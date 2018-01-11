'use strict';

const get = require('lodash.get');
const errors = require('@cumulus/common/errors');
const pdr = require('@cumulus/ingest/pdr');
const log = require('@cumulus/ingest/log');
const { StepFunction } = require('@cumulus/ingest/aws');

/**
* Parse a PDR
* See schemas/input.json for detailed input schema
* @param {object} event
* @param {object} event.config
* @param {string} event.config.stack
* @param {object} event.config.pdrFolder
* @param {string} event.config.pdrFolder.pdrs
* @param {object} event.config.provider
* @param {object} event.config.buckets
* @param {object} event.config.collection
* @returns {undefined} see schemas/output.json for detailed output schema
* that is passed to the next task in the workflow
**/
module.exports.handler = function handler(_event, context, cb) {
  try {
    let event;
    let parse;
    StepFunction.pullEvent(_event).then((ev) => {
      event = ev;
      const config = get(event, 'config');
      const provider = get(config, 'provider', null);
      const queue = get(config, 'useQueue', true);

      if (!provider) {
        const err = new errors.ProviderNotFound('Provider info not provided');
        log.error(err);
        return cb(err);
      }

      const Parse = pdr.selector('parse', provider.protocol, queue);
      parse = new Parse(event);

      return parse.ingest();
    }).then((payload) => {
      if (parse && parse.connected) {
        parse.end();
      }

      const output = Object.assign({}, event.input, payload);
      return StepFunction.pushEvent(output);
    }).then(ev => {
      console.log('ev', ev)
      cb(null, ev)
    })
      .catch(e => {
        if (parse && parse.connected) {
          parse.end();
        }

        if (e.toString().includes('ECONNREFUSED')) {
          const err = new errors.RemoteResourceError('Connection Refused');
          log.error(err);
          return cb(err);
        }
        else if (e.details && e.details.status === 'timeout') {
          const err = new errors.ConnectionTimeout('connection Timed out');
          log.error(err);
          return cb(err);
        }

        log.error(e);
        return cb(e);
      });
  }
  catch (e) {
    log.error(e);
    throw e;
  }
};
