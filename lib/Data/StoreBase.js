/*
 * This file is part of the Companion project
 * Copyright (c) 2018 Bitfocus AS
 * Authors: William Viker <william@bitfocus.io>, Håkon Nessjøen <haakon@bitfocus.io>
 *
 * This program is free software.
 * You should have received a copy of the MIT licence as well as the Bitfocus
 * Individual Contributor License Agreement for companion along with
 * this program.
 *
 * You can be released from the requirements of the license by purchasing
 * a commercial license. Buying such a license is mandatory as soon as you
 * develop commercial activities involving the Companion software without
 * disclosing the source code of your own applications.
 *
 */

const CoreBase = require('../Core/Base')
const fs = require('fs-extra')
const path = require('path')
const { cloneDeep } = require('lodash')

/**
 * Abstract class to be extended by the flat file DB classes.
 * See {@link Config} and {@link Database}
 *
 * @extends CoreBase
 * @author Håkon Nessjøen <haakon@bitfocus.io>
 * @author Julian Waller <me@julusian.co.uk>
 * @author Keith Rocheck <keith.rocheck@gmail.com>
 * @author William Viker <william@bitfocus.io>
 * @since 2.3.0
 * @abstract
 */
class DataStoreBase extends CoreBase {
	cfgBakFile = null
	cfgCorruptFile = null
	cfgDir = null
	cfgFile = null
	cfgTmpFile = null
	defaults = null
	dirty = false
	lastsave = Date.now()
	name = null
	saveInterval = null
	saving = false
	store = {}

	/**
	 * Create a new flat file DB controller
	 * @param {Registry} registry - the core registry
	 * @param {string} name - the name of the flat file
	 * @param {string} cfgDir - the directory the flat file will be saved
	 * @param {number} saveInterval - minimum interval in ms to save to disk
	 * @param {Object[]} defaults - the default data to use when making a new file
	 */
	constructor(registry, name, cfgDir, saveInterval, defaults) {
		super(registry, name)
		this.name = name
		this.cfgDir = cfgDir
		this.cfgFile = path.join(cfgDir, name)
		this.cfgBakFile = path.join(cfgDir, name + '.bak')
		this.cfgCorruptFile = path.join(cfgDir, name + '.corrupt')
		this.cfgTmpFile = path.join(cfgDir, name + '.tmp')
		this.saveInterval = saveInterval
		this.defaults = defaults
	}

	/**
	 * Delete a key/value pair
	 * @param {string} key - the key to be delete
	 * @access public
	 */
	deleteKey(key) {
		this.debug(`${this.name}_del (${key})`)
		if (key !== undefined) {
			delete this.store[key]
			this.setDirty()
		}
	}

	/**
	 * Save the database to file making a `FILE.bak` version then moving it into place
	 * @async
	 * @param {boolean} [withBackup = true] - can be set to `false` if the current file should not be moved to `FILE.bak`
	 * @access protected
	 */
	async doSave() {
		const jsonSave = JSON.stringify(this.store)
		this.dirty = false
		this.lastsave = Date.now()

		if (withBackup === true && fs.existsSync(this.cfgFile) && fs.readFileSync(this.cfgFile, 'utf8').trim().length > 0) {
			try {
				await fs.copy(this.cfgFile, this.cfgBakFile)
				this.debug(`${this.name}_save`, `backup written`)
			} catch (err) {
				this.debug(`${this.name}_save`, `Error making backup copy: ${err}`)
			}
		}

		try {
			await fs.writeFile(this.cfgTmpFile, jsonSave)
		} catch (err) {
			this.debug(`${this.name}_save`, `Error saving: ${err}`)
			throw 'Error saving: ' + err
		}

		this.debug(`${this.name}_save`, 'written')

		try {
			await fs.rename(this.cfgTmpFile, this.cfgFile)
		} catch (err) {
			this.debug('db_save', `Error renaming ${this.name}.tmp: ` + err)
			throw `Error renaming ${this.name}.tmp: ` + err
		}

		this.debug(`${this.name}_save`, 'renamed')
		this.system.emit('db_saved', null)
	}

	/**
	 * Get the entire database
	 * @param {boolean} [clone = false] - <code>true</code> if a clone is needed instead of a link
	 * @returns {Object[]} the database
	 * @access public
	 */
	getAll(clone = false) {
		let out
		this.debug(`${this.name}_get_all`)

		if (clone === true) {
			out = cloneDeep(this.store)
		} else {
			out = this.store
		}

		return out
	}

	/**
	 * The directory of the flat file
	 * @type {string}
	 * @access public
	 * @readonly
	 */
	get cfgDir() {
		return this.cfgDir
	}

	/**
	 * Get a value from the database
	 * @param {string} key - the key to be retrieved
	 * @param {?Object[]} defaultValue - the default value to use if the key doesn't exist
	 * @param {boolean} [clone = false] - <code>true</code> if a clone is needed instead of a link
	 * @access public
	 */
	getKey(key, defaultValue, clone = false) {
		let out
		this.debug(`${this.name}_get(${key})`)

		if (this.store[key] === undefined && defaultValue !== undefined) {
			this.store[key] = defaultValue
			this.setDirty()
		}

		if (clone === true) {
			out = cloneDeep(this.store[key])
		} else {
			out = this.store[key]
		}

		return out
	}

	/**
	 * Attempt to load the database from disk
	 * @access protected
	 */
	loadSync() {
		if (fs.existsSync(this.cfgFile)) {
			this.debug(this.cfgFile, 'exists. trying to read')
			let data = fs.readFileSync(this.cfgFile, 'utf8')

			try {
				if (data.trim().length > 0) {
					this.store = JSON.parse(data)
					this.debug('parsed JSON')
				} else {
					this.log('warn', `${this.name} was empty.  Attempting to recover the configuration.`)
					this.loadBackupSync(this.cfgBakFile)
				}
			} catch (e) {
				try {
					fs.copyFileSync(this.cfgFile, this.cfgCorruptFile)
					this.log('error', `${this.name} could not be parsed.  A copy has been saved to ${this.cfgCorruptFile}.`)
					fs.rmSync(this.cfgFile)
				} catch (err) {
					this.debug(`${this.name}_load`, `Error making or deleting corrupted backup: ${err}`)
				}

				this.loadBackupSync(this.cfgBakFile)
			}
		} else if (fs.existsSync(this.cfgBakFile)) {
			this.log('warn', `${this.name} is missing.  Attempting to recover the configuration.`)
			this.loadBackupSync(this.cfgBakFile)
		} else {
			this.loadDefaults()
		}

		this.setSaveCycle()
	}

	/**
	 * Attempt to load the backup file from disk as a recovery
	 * @access protected
	 */
	loadBackupSync() {
		if (fs.existsSync(this.cfgBakFile)) {
			this.debug(this.cfgBakFile, 'exists. trying to read')
			let data = fs.readFileSync(this.cfgBakFile, 'utf8')

			try {
				if (data.trim().length > 0) {
					this.store = JSON.parse(data)
					this.debug('parsed JSON')
					this.log('warn', `${this.name}.bak has been used to recover the configuration.`)
					this.save(false)
				} else {
					this.loadDefaults()
				}
			} catch (e) {
				this.loadDefaults()
			}
		} else {
			this.loadDefaults()
		}
	}

	/**
	 * Save the defaults since a file could not be found/loaded/parsed
	 * @access protected
	 */
	loadDefaults() {
		this.debug(this.cfgFile, 'didnt exist. loading defaults', this.defaults)
		this.store = this.defaults
		this.save()
	}

	/**
	 * Save the database to file
	 * @param {boolean} [withBackup = true] - can be set to `false` if the current file should not be moved to `FILE.bak`
	 * @access protected
	 */
	save(withBackup = true) {
		if (this.saving === false) {
			this.debug('db_save', 'begin')
			this.saving = true

			this.doSave(withBackup)
				.catch((err) => {
					try {
						this.log('error', err)
					} catch (err2) {
						this.debug('db_save', 'Error reporting save failue: ' + err2)
					}
				})
				.then(() => {
					// This will run even if the catch caught an error
					this.saving = false
				})
		}
	}

	/**
	 * Execute a save if the database is dirty
	 * @access public
	 */
	saveImmediate() {
		if (this.dirty === true) {
			this.save()
		}
	}

	/**
	 * Register that there are changes in the database that need to be saved as soon as possible
	 * @access public
	 */
	setDirty() {
		this.dirty = true
	}

	/**
	 * Save/update a key/value pair to the database
	 * @param {(number|string)} key - the key to save under
	 * @param {Object} value - the object to save
	 * @access public
	 */
	setKey(key, value) {
		this.debug(`${this.name}_set(${key}, ${value})`)

		if (key !== undefined) {
			this.store[key] = value
			this.setDirty()
		}
	}

	/**
	 * Save/update multiple key/value pairs to the database
	 * @param {Array.<(number|string),Object>} keyvalueobj - the key to save under
	 * @access public
	 */
	setKeys(keyvalueobj) {
		this.debug(`${this.name}_set_multiple:`)

		if (keyvalueobj !== undefined && typeof keyvalueobj == 'object' && keyvalueobj.length > 0) {
			for (let key in keyvalueobj) {
				this.debug(`${this.name}_set(${key}, ${keyvalueobj[key]})`)
				this.store[key] = keyvalueobj[key]
			}

			this.setDirty()
		}
	}

	/**
	 * Setup the save cycle interval
	 * @access protected
	 */
	setSaveCycle() {
		this.saveCycle = setInterval(() => {
			// See if the database is dirty and needs to be saved
			if (Date.now() - this.lastsave > this.saveInterval && this.dirty) {
				this.save()
			}
		}, this.saveInterval)
	}
}

exports = module.exports = DataStoreBase