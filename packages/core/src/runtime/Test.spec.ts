import 'mocha'
import { use, expect } from 'chai'
import * as Sinon from 'sinon'
import * as SinonChai from 'sinon-chai'
import { DogfoodServer } from '../../tests/support/fixture-server'
import testRunEnv from '../../tests/support/test-run-env'
import PuppeteerDriver from '../driver/Puppeteer'
import Test from './Test'
import { mustCompileFile } from '../TestScript'
import { join } from 'path'
import { PuppeteerClient } from '../types'
import { Measurement, TraceData } from '../Reporter'
import { EventEmitterReporter } from '../reporter/EventEmitter'
use(SinonChai)

let dogfoodServer = new DogfoodServer()
let test: Test, client: PuppeteerClient, driver: PuppeteerDriver
let testReporter: EventEmitterReporter = new EventEmitterReporter()
const runEnv = testRunEnv()

function ensureDefined(value: any | undefined | null): any | never {
	if (value === undefined || value === null) {
		throw new Error('value was not defined')
	} else {
		return value
	}
}

const setupTest = async (scriptName: string) => {
	let script = await mustCompileFile(join(__dirname, '../../tests/fixtures', scriptName))
	test.enqueueScript(script)
	await driver.launch()
	client = await driver.client()
	test.attachDriver(client)
}

describe('Test', function() {
	this.timeout(30e3)
	beforeEach(async () => {
		driver = new PuppeteerDriver()
		testReporter = new EventEmitterReporter()
		test = new Test(runEnv, testReporter)
	})

	afterEach(async () => {
		await driver.close()
	})

	before(async () => {
		await dogfoodServer.start()
	})

	after(async () => {
		await dogfoodServer.close()
	})

	it('extracts settings during evaluation', async () => {
		await setupTest('test-with-export.ts')
		expect(test.settings).to.deep.equal({
			actionDelay: 5,
			stepDelay: 0,
			clearCache: false,
			device: 'Chrome Desktop Large',
			ignoreHTTPSErrors: false,
			userAgent:
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3282.186 Safari/537.36',
			clearCookies: true,
			duration: -1,
			loopCount: Infinity,
			name: 'Example Test',
			description: 'This is an example test',
			screenshotOnFailure: true,
			waitTimeout: 30,
			responseTimeMeasurement: 'step',
			consoleFilter: [],
		})
	})

	it('parses steps', async () => {
		await setupTest('test-with-export.ts')

		expect(test.steps.map(step => step.name)).to.deep.equal(['Invalid Step', 'Test Step'])
	})

	it('runs steps', async () => {
		await setupTest('test-with-export.ts')

		await test.run()
	}).timeout(30e3)

	describe('Assertion handling', () => {
		it('captures assertions from assert', async () => {
			let traces: TraceData[] = []

			testReporter.on('trace', (label, responseCode, traceData) => {
				traces.push(traceData)
			})

			let scriptFilename = join(__dirname, '../../tests/fixtures/test-with-assert.ts')
			await setupTest('test-with-assert.ts')
			await test.run()

			expect(traces.length).to.equal(1)

			const trace: TraceData = ensureDefined(traces[0])
			const assertions = ensureDefined(trace.assertions)

			expect(assertions.length).to.equal(1)
			let [assertion] = assertions

			expect(assertion.assertionName).to.equal('AssertionError')
			expect(assertion.message).to.equal("'show bar' == 'foobarlink'")

			expect(assertion.stack.length).to.equal(1)

			// match bits of the stack line to avoid a bit of fragility
			let [stackLine] = assertion.stack
			expect(stackLine).to.include('.step ')
			expect(stackLine).to.include(scriptFilename)
			// XXX too fragile, differs depending on... something
			// expect(stackLine).to.include(':21:9')
		}).timeout(30e3)
	})

	// TODO error handling

	describe('Timing', () => {
		describe('step', () => {
			it('measures step wall time without think time', async () => {
				await setupTest('test-with-assert.ts')
				test.settings.responseTimeMeasurement = 'step'
				test.settings.actionDelay = 1

				let didReportMeasurement = false

				let measurementSpy = Sinon.spy()
				let objectSpy = Sinon.spy()

				testReporter.on('measurement', (measurement: Measurement) => {
					measurementSpy(measurement.measurement)
					if (measurement.measurement === 'response_time') {
						expect(Number(measurement.value)).to.be.lessThan(2000)
						expect(Number(measurement.value)).to.be.greaterThan(20)
						didReportMeasurement = true
					}
				})

				testReporter.on('trace', (label, responseCode, traceData) => {
					const objTypes = ensureDefined(traceData).objectTypes
					objectSpy(objTypes)
				})

				await test.run()

				expect(didReportMeasurement).to.be.true
				expect(measurementSpy).to.have.been.calledWith('response_time')
				expect(measurementSpy).to.have.been.calledWith('concurrency')
				expect(measurementSpy).to.have.been.calledWith('passed')
				expect(measurementSpy).to.have.been.calledWith('failed')
				expect(measurementSpy).to.have.been.calledWith('latency')
				expect(objectSpy).to.have.been.calledWith(['trace'])
			})
		})

		describe('page', () => {
			it('measures page network response time', async () => {
				await setupTest('test-with-assert.ts')
				test.settings.responseTimeMeasurement = 'page'
				test.settings.actionDelay = 0.25

				testReporter.on('measurement', (measurement: Measurement) => {
					if (measurement.measurement === 'response_time') {
						console.log(Number(measurement.value))
						expect(Number(measurement.value)).to.equal(test.networkRecorder.responseTime())
					}
				})

				await test.run()
			})
		})

		describe('network', () => {
			it.skip('measures network network response time', async () => {
				let scriptFilename = join(__dirname, '../../tests/fixtures/test-with-assert.ts')
				let script = await mustCompileFile(scriptFilename)
				test.enqueueScript(script)
				test.settings.responseTimeMeasurement = 'network'
				test.settings.actionDelay = 0.25

				testReporter.on('measurement', (measurement: Measurement) => {
					if (measurement.measurement === 'response_time') {
						console.log(Number(measurement.value))
						// expect(Number(measurement.value)).to.equal(test.networkRecorder.responseTime())
					}
				})

				await test.run()
			})

			it('records network entries', async () => {
				await setupTest('dogfood-test-wait.ts')
				test.settings.responseTimeMeasurement = 'network'

				console.log('running')
				let responseTimeMeasurements: Measurement[] = []
				testReporter.on('measurement', (measurement: Measurement) => {
					console.log('measurement', measurement)
					if (measurement.measurement === 'response_time') {
						responseTimeMeasurements.push(measurement)
					}
				})

				await test.run()

				let responseTime = responseTimeMeasurements
					.map(m => Number(m.value))
					.reduce((sum, n) => sum + n, 0)
				expect(responseTime).to.be.greaterThan(1)

				// Network recorder should now be reset
				// expect(test.networkRecorder.entries.length).to.equal(0)
			}).timeout(30e3)
		})
	})
})