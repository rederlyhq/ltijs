
const Database = require('./Database')
const crypto = require('crypto')
const jwk = require('pem-jwk')
const got = require('got')
const find = require('lodash.find')
const jwt = require('jsonwebtoken')
const provAuthDebug = require('debug')('provider:auth')
// const cons_authdebug = require('debug')('consumer:auth')

/**
 * @description Authentication class manages RSA keys and validation of tokens.
 */
class Auth {
  /**
     * @description Generates a new keypairfor the platform.
     * @param {String} ENCRYPTIONKEY - Encryption key.
     * @returns {String} kid for the keypair.
     */
  static async generateProviderKeyPair (ENCRYPTIONKEY) {
    let kid = crypto.randomBytes(16).toString('hex')

    while (await Database.Get(false, 'publickey', { kid: kid })) {
      kid = crypto.randomBytes(16).toString('hex')
    }

    let keys = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs1',
        format: 'pem'
      }
    })

    let { publicKey, privateKey } = keys

    let pubkeyobj = {
      key: publicKey
    }
    let privkeyobj = {
      key: privateKey
    }

    await Database.Insert(ENCRYPTIONKEY, 'publickey', pubkeyobj, { kid: kid })
    await Database.Insert(ENCRYPTIONKEY, 'privatekey', privkeyobj, { kid: kid })

    return kid
  }

  /**
     * @description Resolves a promisse if the token is valid following LTI 1.3 standards.
     * @param {String} token - JWT token to be verified.
     * @param {Function} getPlatform - getPlatform function to get the platform that originated the token.
     * @param {String} ENCRYPTIONKEY - Encription key.
     * @returns {Promise}
     */
  static async validateToken (token, getPlatform, ENCRYPTIONKEY) {
    let decodedToken = jwt.decode(token, { complete: true })

    let kid = decodedToken.header.kid
    let alg = decodedToken.header.alg

    provAuthDebug('Attempting to retrieve registered platform')
    let platform = await getPlatform(decodedToken.payload.iss, ENCRYPTIONKEY)
    if (!platform) throw new Error('NoPlatformRegistered')

    let authConfig = platform.platformAuthConfig()

    switch (authConfig.method) {
      case 'JWK_SET': {
        provAuthDebug('Retrieving key from jwk_set')
        if (!kid) throw new Error('NoKidFoundInToken')

        let keysEndpoint = authConfig.key
        let res = await got.get(keysEndpoint)
        let keyset = JSON.parse(res.body).keys
        if (!keyset) throw new Error('NoKeySetFound')
        let key = jwk.jwk2pem(find(keyset, ['kid', kid]))
        if (!key) throw new Error('NoKeyFound')

        let verified = await this.verifyToken(token, key, alg, platform)
        return (verified)
      }
      case 'JWK_KEY': {
        provAuthDebug('Retrieving key from jwk_key')
        if (!authConfig.key) throw new Error('NoKeyFound')

        let key = jwk.jwk2pem(authConfig.key)

        let verified = await this.verifyToken(token, key, alg, platform)
        return (verified)
      }
      case 'RSA_KEY': {
        provAuthDebug('Retrieving key from rsa_key')
        let key = authConfig.key
        if (!key) throw new Error('NoKeyFound')

        let verified = await this.verifyToken(token, key, alg, platform)
        return (verified)
      }
    }
  }

  /**
     * @description Verifies a token.
     * @param {Object} token - Token to be verified.
     * @param {String} key - Key to verify the token.
     * @param {String} alg - Algorithm used.
     * @param {Platform} platform - Issuer platform.
     */
  static async verifyToken (token, key, alg, platform) {
    provAuthDebug('Attempting to verify JWT with the given key')

    let decoded = jwt.verify(token, key, { algorithms: [alg] })
    await this.oidcValidationSteps(decoded, platform, alg)

    return decoded
  }

  /**
     * @description Validates de token based on the OIDC specifications.
     * @param {Object} token - Id token you wish to validate.
     * @param {Platform} platform - Platform object.
     * @param {String} alg - Algorithm used.
     */
  static async oidcValidationSteps (token, platform, alg) {
    provAuthDebug('Token signature verified')
    provAuthDebug('Initiating OIDC aditional validation steps')

    let aud = this.validateAud(token, platform)
    let _alg = this.validateAlg(alg)
    let iat = this.validateIat(token)
    let nonce = this.validateNonce(token)

    return Promise.all([aud, _alg, iat, nonce])
  }

  /**
     * @description Validates Aud.
     * @param {Object} token - Id token you wish to validate.
     * @param {Platform} platform - Platform object.
     */
  static async validateAud (token, platform) {
    provAuthDebug("Validating if aud (Audience) claim matches the value of the tool's clientId given by the platform")
    provAuthDebug('Aud claim: ' + token.aud)
    provAuthDebug("Tool's clientId: " + platform.platformClientId())
    if (!token.aud.includes(platform.platformClientId())) throw new Error('AudDoesNotMatchClientId')
    if (Array.isArray(token.aud)) {
      provAuthDebug('More than one aud listed, searching for azp claim')
      if (token.azp && token.azp !== platform.platformClientId()) throw new Error('AzpClaimDoesNotMatchClientId')
    }
    return true
  }

  /**
     * @description Validates Aug.
     * @param {String} alg - Algorithm used.
     */
  static async validateAlg (alg) {
    provAuthDebug('Checking alg claim. Alg: ' + alg)
    if (alg !== 'RS256') throw new Error('NoRSA256Alg')
    return true
  }

  /**
     * @description Validates Iat.
     * @param {Object} token - Id token you wish to validate.
     */
  static async validateIat (token) {
    provAuthDebug('Checking iat claim to prevent old tokens from being passed.')
    provAuthDebug('Iat claim: ' + token.iat)
    let curTime = Date.now() / 1000
    provAuthDebug('Current_time: ' + curTime)
    let timePassed = curTime - token.iat
    provAuthDebug('Time passed: ' + timePassed)
    if (timePassed > 10) throw new Error('TokenTooOld')
    return true
  }

  /**
     * @description Validates Nonce.
     * @param {Object} token - Id token you wish to validate.
     */
  static async validateNonce (token) {
    provAuthDebug('Validating nonce')
    provAuthDebug('Nonce: ' + token.nonce)

    if (await Database.Get(false, 'nonce', { nonce: token.nonce })) throw new Error('NonceAlreadyStored')
    else {
      provAuthDebug('Storing nonce')
      Database.Insert(false, 'nonce', { nonce: token.nonce })
    }
    return true
  }

  /**
     * @description Gets a new access token from the platform.
     * @param {Platform} platform - Platform object of the platform you want to access.
     */
  static async getAccessToken (platform, ENCRYPTIONKEY) {
    let confjwt = {
      iss: platform.platformClientId(),
      sub: platform.platformClientId(),
      aud: [platform.platformAccessTokenEndpoint()],
      iat: Date.now() / 1000,
      exp: Date.now() / 1000 + 60,
      jti: crypto.randomBytes(16).toString('base64')
    }

    let token = jwt.sign(confjwt, await platform.platformPrivateKey(), { algorithm: 'RS256', keyid: platform.platformKid() })

    let message = {
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: token,
      scope: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem https://purl.imsglobal.org/spec/lti-ags/scope/score https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly'

    }

    provAuthDebug('Awaiting return from the platform')
    let res = await got(platform.platformAccessTokenEndpoint(), { body: message, form: true })

    provAuthDebug('Successfully generated new access_token')
    let access = JSON.parse(res.body)

    provAuthDebug('Access token: ')
    provAuthDebug(access)

    await Database.Insert(ENCRYPTIONKEY, 'accesstoken', { token: access }, { platformUrl: platform.platformUrl() })

    return access
  }
}

module.exports = Auth
