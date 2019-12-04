/*************************************************************************
* ADOBE CONFIDENTIAL
* ___________________
*
* Copyright 2019 Adobe
* All Rights Reserved.
*
* NOTICE: All information contained herein is, and remains
* the property of Adobe and its suppliers, if any. The intellectual
* and technical concepts contained herein are proprietary to Adobe
* and its suppliers and are protected by all applicable intellectual
* property laws, including trade secret and copyright laws.
* Dissemination of this information or reproduction of this material
* is strictly forbidden unless prior written permission is obtained
* from Adobe.
**************************************************************************/

'use strict';

const S3 = require('aws-sdk/clients/s3');
const fetch = require('node-fetch');
const fs = require('fs');
const validUrl = require('valid-url');
const {promisify} = require('util');
const fileExists = promisify(fs.exists);
const _string = require('underscore.string');

class ContainerAws {

    /**
     * @typedef {Object} S3BucketOptions
     * @property {String} [cdnUrl=] - Overrides the protocol and host of presigned GET/PUT urls, e.g. https://cdnhost
     * @property {String} [bucketRegion] - S3 bucket region
     */
    /**
     * @typedef {Object} Auth
     * @property {String} accessKeyId - AWS access key
     * @property {String} secretAccessKey - AWS secret key
     */
    /**
     * Creates an S3 service object to run actions against
     *
     * @param {Auth} auth - S3 bucket credentials
     * @param {String} bucketName - Name of the S3 bucket
     * @param {S3BucketOptions} [options=] - Options
     */
    constructor(auth, bucketName, options) {

        if (!auth || Object.keys(auth).length === 0 ||
        _string.isBlank(auth.secretAccessKey) ||
        _string.isBlank(auth.accessKeyId)) {

            throw "Authentication was not provided";
        }

        if (!bucketName || _string.isBlank(bucketName)) {
            throw "S3 bucket name was not provided";
        }

        this.bucketName = bucketName;
        this.cdnUrl = options && options.cdnUrl;

        const params = {
            accessKeyId: auth.accessKeyId,
            secretAccessKey: auth.secretAccessKey,
            signatureVersion: "v4"
        };

        if(options && (options.hasOwnProperty("bucketRegion") && !_string.isBlank(options.bucketRegion))) {
            params.region = options.bucketRegion.trim();
        }

        this.s3 = new S3(params);
    }

    /**
     * Validates S3 bucket by retrieving the ACL
     *
     * @return {Boolean} True if bucket is valid
     */
    async validate() {
        const params = {
            Bucket: this.bucketName
        };

        const getBucketAcl = promisify(this.s3.getBucketAcl).bind(this.s3);
        const result = await getBucketAcl(params);

        if (result && result.Grants) {
            return true;
        }
    }

    /**
     * Creates a read-only presigned URL to retrieve object in S3 bucket
     *
     * @param {String} keyName - Source S3 object key name
     * @param {Number} ttl - Length of time in milliseconds before expiration
     * @return {String} Read-only presigned URL
     */
    presignGet(keyName, ttl) {

        const params = {
            Bucket: this.bucketName,
            Key: keyName,
            Expires: ttl
        };
        return this.s3.getSignedUrl("getObject", params);
    }

    /**
     * Creates a write-only presigned URL to upload asset to S3 bucket
     *
     * @param {String} keyName - Desired key name of the target S3 object
     * @param {Number} ttl - Length of time in milliseconds before expiration
     * @return {String} Write-only presigned URL
     */
    presignPut(keyName, ttl) {

        const params = {
            Bucket: this.bucketName,
            Key: keyName,
            Expires: ttl
        };
        return this.s3.getSignedUrl("putObject", params);
    }

    /**
     * Uploads source to S3 bucket from URL as a stream
     *
     * @param {String} sourceUrl - Asset URL to create readable stream from
     * @param {String} keyName - Target S3 object key name
     */
    async uploadFromUrl(sourceUrl, keyName) {

        if(!validUrl.isHttpsUri(sourceUrl)) {
            throw `sourceUrl value is not a valid https URL: ${sourceUrl}`;
        }

        const res = await fetch(sourceUrl);
        if (!res.ok) {
            throw `Unable to request ${sourceUrl}: ${res.status}`;
        }
        return this._upload(res.body, keyName);
    }

    /**
     * Uploads asset to S3 object from local disk asset as a stream
     *
     * @param {String} file - Local source to upload
     * @param {String} keyName - Target S3 object key name
     */
    async uploadFromFile(file, keyName) {

        if(await !fileExists(file)) {
            throw `File does not exist: ${file}`;
        }

        const stream = fs.createReadStream(file);
        return this._upload(stream, keyName);
    }

    /**
     * Downloads S3 object to local disk
     *
     * @param {String} file - Local path to save S3 object
     * @param {String} keyName - S3 object key name to download
     */
    async downloadAsset (file, keyName) {

        const writeStream = fs.createWriteStream(file);

        const options = {
            Bucket: this.bucketName,
            Key: keyName
        };

        return new Promise((resolve, reject) => {
            writeStream.on("error", error => {
                reject(error);
            });

            this.s3.getObject(options)
                .createReadStream()
                .on("error", error => { // NoSuchKey: The specified key does not exist
                    reject(error);
                })
                .pipe(writeStream)
                .on("error", error => { // Errors that occur when writing data
                    reject(error);
                })
                .on("close", () => {
                    resolve();
                });
        });
    }

    /**
     * @typedef {Object} ListS3Objects[]
     * @property {String} keyName - S3 object key name
     * @property {Number} contentLength - Length of the S3 object in bytes
     */
    /**
     * Lists all S3 objects based on prefix
     *
     * @param {String} [prefix] - The virtual path of the S3 objects to list`
     * @return {ListS3Objects[]} List of S3 objects
     */
    async listObjects(prefix) {

        let response;
        const results = [];

        const params = {
            Bucket: this.bucketName
        };

        if (prefix && prefix.length > 0) {
            params.Prefix = prefix;
        }

        do {
            response = await this.s3.listObjects(params).promise();
            response.Contents.forEach(item => {
                results.push({
                    name: item.Key,
                    contentLength: item.Size
                });
            });

            if (response.IsTruncated) {
                params.Marker = response.Contents.slice(-1)[0].Key;
            }
        } while (response.IsTruncated);

        return results;
    }

    /**
     * @typedef {Object} BlobMetadata
     * @param {String} name - Name of blob
     * @param {Number} contentLength - Size of blob
     */
    /**
     * Returns size of S3 object
     *
     * @param {String} keyName - S3 object key name
     * @returns {Number} S3 object size else undefined
     */
    async getMetadata(keyName) {

        const list = await this.listObjects(keyName);

        if (list.length !== 1) {
            return;
        }
        return list[0];
    }

    /**
     * Uploads stream creating an S3 object
     *
     * @param {Stream} stream - Readable stream
     * @param {String} keyName - Target S3 object key name
     */
    async _upload(stream, keyName) {

        const uploadOptions = {
            // Do we want to try and calculate the size and then set part size or let AWS.S3.upload() => AWS.S3.ManagedUpload() do it?
            // Same for multipart - do we want to create more code just to match azure.js?
            queueSize: 20 // 20 concurrency
        };

        const params = {
            Bucket: this.bucketName,
            Key: keyName,
            Body: stream
        };

        return new Promise( (resolve, reject) => {

            this.s3.upload(params, uploadOptions, function (error, results) {
                if (error) {
                    reject(error);
                }
                resolve(results);
            });
        });
    }
}

module.exports = {
    ContainerAws
}