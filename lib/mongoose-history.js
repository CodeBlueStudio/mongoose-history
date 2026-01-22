"use strict";
const mongoose = require('mongoose');
const hm = require('./history-model');
const async = require('async');
const util = require('util');

module.exports = function historyPlugin(schema, options) {
  const customCollectionName  = options && options.customCollectionName;
  const customDiffAlgo = options && options.customDiffAlgo;
  const diffOnly  = options && options.diffOnly;
  const metadata = options && options.metadata;

  // Clear all history collection from Schema
  schema.statics.historyModel = function() {
    return hm.HistoryModel(hm.historyCollectionName(this.collection.name, customCollectionName), options);
  };

  // Clear all history documents from history collection
  schema.statics.clearHistory = function(callback) {
    const History = hm.HistoryModel(hm.historyCollectionName(this.collection.name, customCollectionName), options);
    History.remove({}, function(err) {
      callback(err);
    });
  };

  // Save original data
  schema.post( 'init', function() {
    if (diffOnly){
      this._original = this.toObject();
    }
  });

  function setMetadata(original, d, historyDoc, callback){
    async.each(metadata, (m, cb) => {
      if (typeof(m.value) === 'function'){
        if (m.value.length === 3){
          /** async function */
          m.value(original, d, function(err, data){
            if (err) cb(err);
            historyDoc[m.key] = data;
            cb();
          })
        } else {
          historyDoc[m.key] = m.value(original, d);
          cb();
        }
      } else {
        historyDoc[ m.key] = d ? d[ m.value] : null;
        cb();
      }
    }, callback)
  }

  // Create a copy when insert or update, or a diff log
  schema.pre('save', async function() {
    let historyDoc = {};
    let d;

    if(diffOnly && !this.isNew) {
      // in case that original document is not set, try to load it again
      if (!this._original) {
        this._original = await this.constructor.findOne({ _id: this._id });
        if (this._original) {
          this._original = this._original.toObject();
        }
      }

      var original = this._original;

      // sometimes, for some reason, this._original can be undefined
      // problem with this is that it will not generate a revision, because diff will be identical
      if (original === undefined || original === null) {
        original = this.toJSON();
      }

      delete this._original;
      d = this.toObject();
      var diff = {};
      diff['_id'] = d['_id'];
      for(var k in d){
        if(customDiffAlgo) {
          var customDiff = customDiffAlgo(k, d[k], original[k]);
          if(customDiff) {
            diff[k] = customDiff.diff;
          }
        } else {
          if (!util.isDeepStrictEqual(d[k], original[k])) {
            diff[k] = d[k];
          }
        }
      }

      historyDoc = createHistoryDoc(diff, 'u');
    } else {
      d = this.toObject();
      let operation = this.isNew ? 'i' : 'u';
      historyDoc = createHistoryDoc(d, operation);
    }

    saveHistoryModel(original, d, historyDoc, this.collection.name);
  });

  // Listen on update
  schema.pre('update', function() {
    processUpdate.call(this);
  });

  // Listen on updateOne
  schema.pre('updateOne', function () {
    processUpdate.call(this);
  });

  // Listen on findOneAndUpdate
  schema.pre('findOneAndUpdate', function () {
    processUpdate.call(this);
  });

  // Create a copy on remove
  schema.pre('remove', function() {
    let d = this.toObject();
    let historyDoc = createHistoryDoc(d, 'r');

    saveHistoryModel(this.toObject(), d, historyDoc, this.collection.name);
  });

  // Create a copy on findOneAndRemove
  schema.post('findOneAndRemove', function (doc) {
    processRemove.call(this, doc);
  });

  function createHistoryDoc(d, operation) {
    const { __v, ...doc } = d;

    let historyDoc = {};
    historyDoc['t'] = new Date();
    historyDoc['o'] = operation;
    historyDoc['d'] = doc;

    return historyDoc;
  }

  function saveHistoryModel(original, d, historyDoc, collectionName) {
    if (metadata) {
      setMetadata(original, d, historyDoc, (err) => {
        if (err) return err;
        let history = new hm.HistoryModel(hm.historyCollectionName(collectionName, customCollectionName), options)(historyDoc);
        history.save().then(() => undefined);
      });
    } else {
      let history = new hm.HistoryModel(hm.historyCollectionName(collectionName, customCollectionName), options)(historyDoc);
      history.save().then(() => undefined);
    }
  }

  function processUpdate() {
    let d = this._update.$set || this._update;
    let historyDoc = createHistoryDoc(d, 'u');

    saveHistoryModel(this.toObject, d, historyDoc, this.mongooseCollection.collectionName);
  }

  function processRemove(doc) {
    let d = doc.toObject();
    let historyDoc = createHistoryDoc(d, 'r');

    saveHistoryModel(this.toObject, d, historyDoc, this.mongooseCollection.collectionName);
  }

};
