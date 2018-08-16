'use strict';

const _ = require('lodash');
const { Kinesis } = require('aws-sdk');
const { sfn } = require('@cumulus/common/aws');

const {
  LambdaStep,
  getWorkflowArn,
  timeout
} = require('@cumulus/integration-tests');

const { loadConfig } = require('../helpers/testUtils');

const testConfig = loadConfig();

const lambdaStep = new LambdaStep();

const kinesis = new Kinesis({ apiVersion: '2013-12-02', region: testConfig.awsRegion });

const waitPeriodMs = 1000;

/**
 * returns the most recently executed KinesisTriggerTest workflows.
 *
 * @returns {Array<Object>} array of state function executions.
 */
async function getExecutions() {
  const kinesisTriggerTestStpFnArn = await getWorkflowArn(testConfig.stackName, testConfig.bucket, 'KinesisTriggerTest');
  const data = await sfn().listExecutions({
    stateMachineArn: kinesisTriggerTestStpFnArn,
    maxResults: 20
  }).promise();
  return (_.orderBy(data.executions, 'startDate', 'desc'));
}


/**
 * Wait for a number of periods for a kinesis stream to become active.
 *
 * @param {string} streamName - name of kinesis stream to wait for
 * @param {integer} maxNumberElapsedPeriods - number of periods to wait for stream
 *                  default value 30; duration of period is 1000ms
 * @returns {string} current stream status: 'ACTIVE'
 * @throws {Error} - Error describing current stream status
 */
async function waitForActiveStream(streamName, maxNumberElapsedPeriods = 60) {
  let streamStatus = 'Anything';
  let elapsedPeriods = 0;
  let stream;

  /* eslint-disable no-await-in-loop */
  while (streamStatus !== 'ACTIVE' && elapsedPeriods < maxNumberElapsedPeriods) {
    await timeout(waitPeriodMs);
    stream = await kinesis.describeStream({ StreamName: streamName }).promise();
    streamStatus = stream.StreamDescription.StreamStatus;
    elapsedPeriods += 1;
  }
  /* eslint-enable no-await-in-loop */

  if (streamStatus === 'ACTIVE') return streamStatus;
  throw new Error(`Stream never became active:  status: ${streamStatus}`);
}

/**
 * Helper function to delete a stream by name
 *
 * @param {string} streamName - name of kinesis stream to delete
 * @returns {Promise<Object>} - a kinesis delete stream proxy object.
 */
async function deleteTestStream(streamName) {
  return kinesis.deleteStream({ StreamName: streamName }).promise();
}

/**
 *  returns a active kinesis stream, creating it if necessary.
 *
 * @param {string} streamName - name of stream to return
 * @returns {Object} empty object if stream is created and ready.
 * @throws {Error} Kinesis error if stream cannot be created.
 */
async function createOrUseTestStream(streamName) {
  let stream;

  try {
    stream = await kinesis.describeStream({ StreamName: streamName }).promise();
  }
  catch (err) {
    if (err.code === 'ResourceNotFoundException') {
      console.log('Creating a new stream:', streamName);
      stream = await kinesis.createStream({ StreamName: streamName, ShardCount: 1 }).promise();
    }
    else {
      throw err;
    }
  }
  return stream;
}

/**
 * Gets the shard iterator for stream <streamName> using LATEST: Records written to
 * the stream after this shard iterator is retrieved will be returned by calls
 * to GetRecords. NOTE: Shard iterators expire after 5 minutes if not used in a
 * GetRecords call.
 *
 * @param  {string} streamName - Name of the stream of interest
 * @returns {string}            - Shard iterator
 */
async function getShardIterator(streamName) {
  const describeStreamParams = {
    StreamName: streamName
  };

  const streamDetails = await kinesis.describeStream(describeStreamParams).promise();
  const shardId = streamDetails.StreamDescription.Shards[0].ShardId;

  const shardIteratorParams = {
    ShardId: shardId, /* required */
    ShardIteratorType: 'LATEST',
    StreamName: streamName
  };

  const shardIterator = await kinesis.getShardIterator(shardIteratorParams).promise();
  return shardIterator.ShardIterator;
}

/**
 * Gets records from a kinesis stream using a shard iterator.
 *
 * @param  {string} shardIterator - Kinesis stream shard iterator.
 *                                  Shard iterators must be generated using getShardIterator.
 * @returns {Promise}              - kinesis GetRecords promise
 */
async function getRecords(shardIterator) {
  return kinesis.getRecords({ ShardIterator: shardIterator }).promise();
}

/**
 * add a record to the kinesis stream.
 *
 * @param {string} streamName - kinesis stream name
 * @param {Object} record - CNM object to drop on stream
 * @returns {Promise<Object>} - Kinesis putRecord response proxy object.
 */
async function putRecordOnStream(streamName, record) {
  return kinesis.putRecord({
    Data: JSON.stringify(record),
    PartitionKey: '1',
    StreamName: streamName
  }).promise();
}


/**
 * Wait for test stepfunction execution to exist.
 *
 * @param {string} recordIdentifier - random string identifying correct execution for test
 * @param {integer} maxWaitTime - maximum time to wait for the correct execution in milliseconds
 * @param {string} firstStep - The name of the first step of the workflow, used to query if the workflow has started.
 * @returns {Object} - {executionArn: <arn>, status: <status>}
 * @throws {Error} - any AWS error, re-thrown from AWS execution or 'Workflow Never Started'.
 */
async function waitForTestSf(recordIdentifier, maxWaitTime, firstStep = 'SfSnsReport') {
  let timeWaited = 0;
  let workflowExecution;

  /* eslint-disable no-await-in-loop */
  while (timeWaited < maxWaitTime && workflowExecution === undefined) {
    await timeout(waitPeriodMs);
    timeWaited += waitPeriodMs;
    const executions = await getExecutions();
    // Search all recent executions for target recordIdentifier
    for (const execution of executions) {
      const taskInput = await lambdaStep.getStepInput(execution.executionArn, firstStep);
      if (taskInput !== null && taskInput.payload.identifier === recordIdentifier) {
        workflowExecution = execution;
        break;
      }
    }
  }
  /* eslint-disable no-await-in-loop */
  if (timeWaited < maxWaitTime) return workflowExecution;
  throw new Error('Never found started workflow.');
}

module.exports = {
  createOrUseTestStream,
  deleteTestStream,
  getShardIterator,
  getRecords,
  putRecordOnStream,
  waitForActiveStream,
  waitForTestSf
};