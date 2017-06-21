'use strict'

const request = require('request')
const Oas3Tools = require('./oas_3_tools.js')
const log = require('debug')('http')
const querystring = require('querystring')

/**
 * Creates and returns a resolver function that performs API requests for the
 * given GraphQL query.
 *
 * @param  {string} options.path         Path to invoke
 * @param  {string} options.method       Method to invoke
 * @param  {object} options.oas
 * @param  {object} options.argsFromLink Object containing the args for this
 * resolver provided through links
 * @param  {string} options.payloadName  Name of the argument to send as request
 * payload
 * @param  {object} options.data         Data produced by preprocessor.js
 * @return {function}                    Resolver function
 */
const getResolver = ({
  operation,
  oas,
  argsFromLink = {},
  payloadName,
  data
}) => {
  // determine the base URL:
  let baseUrl = Oas3Tools.getBaseUrl(oas)

  // return resolve function:
  return (root, args, ctx) => {
    // handle arguments provided by links:
    if (typeof argsFromLink === 'object') {
      for (let key in argsFromLink) {
        args[key] = root[argsFromLink[key]]
      }
    }

    // build URL (i.e., fill in path parameters):
    let {path, query} = Oas3Tools.instantiatePathAndGetQuery(
      operation.path,
      operation.parameters,
      args)
    let url = baseUrl + path
    // console.log(query)
    // build request options:
    let options = {
      method: operation.method,
      url: url,
      json: true,
      headers: {},
      qs: query
    }

    // determine possible payload:
    // GraphQL produces sanitized payload names, so we have to sanitize before
    // lookup here:
    let sanePayloadName = Oas3Tools.beautify(payloadName)
    if (sanePayloadName in args) {
      // we need to desanitize the payload so the API understands it:
      let rawPayload = Oas3Tools.desanitizeObjKeys(
        args[sanePayloadName], data.saneMap)
      options.body = rawPayload
    }

    // use OASGraph options:
    if (typeof data.options === 'object') {
      // headers:
      if (typeof data.options.headers === 'object') {
        for (let header in data.options.headers) {
          let val = data.options.headers[header]
          options.headers[header] = val
        }
      }
      // query string:
      if (typeof data.options.qs === 'object') {
        for (let query in data.options.qs) {
          let val = data.options.qs[query]
          options.qs[query] = val
        }
      }
    }

    // get authentication headers and query parameters:
    let {authHeaders, authQs} = getAuthOptions(operation, ctx, data)

    // ...and pass them to the options:
    Object.assign(options.headers, authHeaders)
    Object.assign(options.qs, authQs)

    // make the call:
    log(`Call ${options.method.toUpperCase()} ${options.url}` +
      `?${querystring.stringify(options.qs)} ` +
      `headers:${JSON.stringify(options.headers)}`)
    return new Promise((resolve, reject) => {
      request(options, (err, response, body) => {
        if (err) {
          log(err)
          reject(err)
        } else if (response.statusCode > 299) {
          log(`${response.statusCode} - ${Oas3Tools.trim(body, 100)}`)
          reject(new Error(`${response.statusCode} - ${JSON.stringify(body)}`))
        } else {
          log(`${response.statusCode} - ${Oas3Tools.trim(body, 100)}`)
          // deal with the fact that the server might send unsanitized data:
          let saneData = Oas3Tools.sanitizeObjKeys(body)
          resolve(saneData)
        }
      })
    })
  }
}

/**
 * Returns the headers and query strings to authenticate a request (if any).
 *
 * @param  {Object} operation Data from preprocessing about an operation
 * @param  {Object} ctx       GraphQL context
 * @param  {Object} data      Result from preprocessing
 * @return {Object}           Object containing authHeader and authQs object,
 * which hold headers and query parameters respectively to authentication a
 * request.
 */
const getAuthOptions = (operation, ctx, data) => {
  let authHeaders = {}
  let authQs = {}

  // determine if authentication is required, and which protocol (if any) we
  // can use
  let {authRequired, protocolName} = getAuthReqAndProtcolName(operation, ctx, data)

  // possibly, we don't need to do anything:
  if (!authRequired) {
    return {authHeaders, authQs}
  }

  // if authentication is required, but we can't fulfill the protocol, throw:
  if (authRequired && typeof protocolName !== 'string') {
    throw new Error(`Missing information to authenticate API request.`)
  }

  let security = data.security[protocolName]
  switch (security.def.type) {
    case 'apiKey':
      let apiKey = ctx.security[security.parameters.apiKey]
      if (typeof apiKey === 'string') {
        if ('in' in security.def) {
          if (security.def.in === 'header') {
            authHeaders[security.def.name] = ctx.security[security.parameters.apiKey]
          } else if (security.def.in === 'query') {
            authQs[security.def.name] = ctx.security[security.parameters.apiKey]
          } else {
            let error = new Error(`Cannot send apiKey in ${security.def.in}`)
            console.error(error)
            throw error
          }
        }
      } else {
        let error = new Error(`API key '${apiKey}' is not a String`)
        console.error(error)
        throw error
      }
      break

    case 'http':
      switch (security.def.scheme) {
        case 'basic':
          let username = ctx.security[security.parameters.username]
          // console.log('security parameters')
          // console.log(security.parameters)
          let password = ctx.security[security.parameters.password]
          // console.log(`username: ${username}`)
          // console.log(`password: ${password}`)
          if (typeof username === 'string' && typeof password === 'string') {
            authHeaders['Authorization'] = 'Basic ' + new Buffer(username + ':' + password).toString('base64')
            // console.log(`headers: ${options.headers['Authorization']}`)
          } else {
            let error = new Error(`Username '${username}' and password are not Strings`)
            console.error(error)
            throw error
          }
          break

        default:
          let error = new Error(`Cannot recognize http security scheme '${security.def.scheme}'`)
          console.error(error)
          throw error
      }
      // var username = 'username',
      // password = 'password',
      // url = 'http://' + username + ':' + password + '@some.server.com';
      break

    case 'oauth2':
      break

    case 'openIdConnect':
      break

    default:
      let error = new Error(`Cannot recognize security type '${security.def.type}'`)
      console.error(error)
      throw error
  }

  return {authHeaders, authQs}
}

/**
 * Determines whether given operation requires authentication, and which of the
 * (possibly multiple) authentication protocols can be used based on the data
 * present in the given context.
 *
 * @param  {Object} operation Data from preprocessing about an operation
 * @param  {Object} ctx       GraphQL context
 * @param  {Object} data      Result from preprocessing
 * @return {Object}           Contains boolean authRequired and string
 * protocolName fields
 */
const getAuthReqAndProtcolName = (operation, ctx, data) => {
  let result = {
    authRequired: false
  }

  if (typeof operation.securityProtocols === 'object' &&
    Object.keys(operation.securityProtocols).length > 0) {
    result.authRequired = true

    for (let i in operation.securityProtocols) {
      let protocol = operation.securityProtocols[i]
      let protocolName = Object.keys(protocol)[0]
      if (typeof protocolName === 'string' &&
        allParamsPresent(protocolName, ctx, data)) {
        log(`Use ${protocolName} for authentication - all parameters present`)
        result.protocolName = protocolName
      }
    }
  } else {
    result.authRequired = false
  }
  return result
}

/**
 * Determines whether for the given authentication protocol all required
 * parameters are present in the given GraphQL context.
 *
 * @param  {Object} operation Data from preprocessing about an operation
 * @param  {Object} ctx       GraphQL context
 * @param  {Object} data      Result from preprocessing
 * @return {Boolean}          True, if all needed parameters are present, false
 * if not.
 */
const allParamsPresent = (protocolName, ctx, data) => {
  for (let param in data.security[protocolName].parameters) {
    if (typeof ctx.security !== 'object' ||
      !(data.security[protocolName].parameters[param] in ctx.security)) {
      log(`Cannot use ${protocolName} for authentication - missing ${param}`)
      return false
    }
  }
  return true
}

module.exports = {
  getResolver
}
