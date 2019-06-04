import { injectable, inject, ContainerPool } from "@worktile/wt-chaos/container";
import { Id, OperationDescription, FindByPageIndexResult, FindOptions, MongoDBSession } from "@worktile/wt-chaos/repository";
import { BaseService, Response, PageIndexResponse } from "@worktile/wt-rd-core/common";
import { WTError, WTCode, _, constants } from "@worktile/wt-chaos";
import { TestRunRepository, TestRunColumnRepository } from "../repositories";
import { TestRunOperationContext } from "../info/operation-context";
import { TestRunEntity } from "../entities";
import { TestCaseRepository, TestPlanRepository } from "../../../repositories";
import { TestSuiteRepository } from "../../../repositories";
import { TestSuiteEntity } from "../../../entities";
import { PROPERTIES } from "../constants";
import { TreeService, TreeDisplayService } from "@worktile/wt-rd-core/tree";
import { userService } from "@worktile/wt-tartarus-sdk/services";
import { TestCaseService } from "../../../services";
import { NULL_SUITE_TEST_CASE_ARG } from "../../test-case/constants";
import { TestPlanEntity } from "src/modules/test-plan/entities";

const container = ContainerPool.getDefaultContainer();

@injectable()
export class TestRunService extends BaseService {
    @inject()
    private testRunRepository: TestRunRepository;

    @inject()
    private testCaseRepository: TestCaseRepository;

    @inject()
    private testSuiteRepository: TestSuiteRepository;

    @inject()
    private testRunColumnRepository: TestRunColumnRepository;

    @inject()
    private rdCoreTreeService: TreeService<TestSuiteEntity>;

    @inject()
    private testPlanRepository: TestPlanRepository;

    @inject()
    private testCaseService: TestCaseService;

    @inject()
    private rdCoreTreeDisplayService: TreeDisplayService<TestSuiteEntity>;
    constructor() {
        super();
        this.rdCoreTreeService = new TreeService<TestSuiteEntity>(container.resolve<TestSuiteRepository>(
            TestSuiteRepository
        ) as TestSuiteRepository);
        this.rdCoreTreeDisplayService = new TreeDisplayService<TestSuiteEntity>(container.resolve<TestSuiteRepository>(
            TestSuiteRepository
        ) as TestSuiteRepository);
    }

    public async getTestRunBySuiteId(operationContext: TestRunOperationContext, testPlanId: Id): Promise<TestSuiteEntity[]> {
        const operationDescription = OperationDescription.from(operationContext);
        const testRuns = await this.testRunRepository.find(
            operationDescription,
            { test_plan_id: testPlanId },
            {
                projection: { suite_id: 1 }
            }
        );
        const suiteIds = testRuns.map(item => {
            return item.suite_id;
        });
        const childrenSuites = await this.testSuiteRepository.findByIds(operationDescription, suiteIds);
        let parentSuiteIds = [];
        childrenSuites.forEach(item => {
            parentSuiteIds = parentSuiteIds.concat(item.parent_ids);
        });
        const parentSuites = await this.testSuiteRepository.findByIds(operationDescription, parentSuiteIds);
        const suites = childrenSuites.concat(parentSuites) as TestSuiteEntity[];
        return suites;
    }

    public async setTestRunColumns(
        operationContext: TestRunOperationContext,
        testPlanId: Id,
        lockedFields: string[],
        normalFields: string[]
    ) {
        const operationDescription = OperationDescription.from(operationContext);
        // set test run columns
        try {
            await this.testRunColumnRepository.update(
                operationDescription,
                { uid: operationDescription.uid, test_plan_id: testPlanId },
                { $set: { locked_fields: lockedFields, normal_fields: normalFields } }
            );
            return await this.getTestRunProperties(operationDescription, testPlanId);
        } catch (error) {
            throw new WTError(WTCode.internalError, "set test run property failure", null, null);
        }
    }

    public async getTestRuns(operationContext: TestRunOperationContext, testPlanId: Id, query: any, pageIndex?: number, pageSize?: number) {
        const operationDescription = OperationDescription.from(operationContext);
        const search_condition = await this.getTestRunsCondition(operationContext, testPlanId, query);
        let options: FindOptions<TestRunEntity, MongoDBSession> = {};
        if (query.sort_by && query.sort_direction) {
            options.sort = [query.sort_by, Number(query.sort_direction)];
        }
        const findTestRunsByPageResult: FindByPageIndexResult<TestRunEntity> = await this.testRunRepository.findByPageIndex(
            operationDescription,
            search_condition,
            pageIndex,
            pageSize,
            options
        );
        const userIds: string[] = [];
        const suiteIds: Id[] = [];
        findTestRunsByPageResult.entities.forEach(m => {
            if (m.executor_uid) {
                userIds.push(m.executor_uid.toString());
            }
            if (m.suite_id) {
                suiteIds.push(m.suite_id);
            }
        });
        // belong to suite
        const suites = (await this.rdCoreTreeDisplayService.getTreeNodes(operationContext, {
            _id: { $in: suiteIds }
        })) as TestSuiteEntity[];

        // get users which include property ["uid","name","display_name","desc","avatar","mobile","email"]
        const users = await userService.getUserByIds(operationDescription, userIds, {
            projection: {
                uid: 1,
                name: 1,
                display_name: 1,
                desc: 1,
                avatar: 1,
                mobile: 1,
                email: 1
            }
        });
        const columns = await this.getTestRunProperties(operationDescription, testPlanId);
        // get test cases
        let testCaseIds = [];
        for (const run of findTestRunsByPageResult.entities) {
            // const testCase = await this.testCaseRepository.findOneById(operationDescription, run.test_case_id, null);
            testCaseIds.push(run.test_case_id);
        }
        const testCases = await this.testCaseRepository.findByIds(operationDescription, testCaseIds);
        return { findTestRunsByPageResult, users, suites, columns, testCases };
    }

    private async getTestRunProperties(operationDescription: OperationDescription, testPlanId: Id) {
        const columns = [];
        const header = await this.testRunColumnRepository.findOne(operationDescription, {
            uid: operationDescription.uid,
            test_plan_id: testPlanId
        });
        const values = _.values(PROPERTIES);
        if (header.locked_fields && header.locked_fields.length > 0) {
            header.locked_fields.forEach(item => {
                const value = values.find(k => k.key == item);
                if (value) {
                    columns.push({ key: item, is_locked: 1, name: value.name, type: value.type });
                }
            });
        }
        if (header.normal_fields && header.normal_fields.length > 0) {
            header.normal_fields.forEach(item => {
                const value = values.find(k => k.key == item);
                if (value) {
                    columns.push({ key: item, is_locked: 0, name: value.name, type: value.type });
                }
            });
        }
        return columns;
    }

    public async getTestRunsCondition(operationContext, testPlanId, query) {
        const search_condition: {
            test_plan_id: Id;
            executor?: any;
            priority?: number;
            status?: number;
            test_case_id?: any;
            suite_id?: Id;
        } = {
            test_plan_id: testPlanId
        };
        const testPlanEntities = (await this.testPlanRepository.findOneById(OperationDescription.from(operationContext),testPlanId, {projection: {test_case_ids:1}})) as TestPlanEntity[];
        let uniqTestCaseIds = [];
        uniqTestCaseIds.concat(testPlanEntities.map(e => e.test_case_ids));
        if (query.title) {
            const reg = new RegExp(_.trim(query.title), "i");
            const testCaseEntities = await this.testCaseRepository.find(OperationDescription.from(operationContext), { title: reg });
            const testCaseIds = testCaseEntities.map(e => e._id);
            uniqTestCaseIds = _.intersection(uniqTestCaseIds, testCaseIds);
            search_condition.test_case_id = { $in: uniqTestCaseIds };
        }
        if (query.executor) {
            search_condition.executor = query.executor;
        }
        if (query.priority) {
            search_condition.priority = Number(query.priority);
        }
        if (query.status) {
            search_condition.status = Number(query.status);
        }
        if (query.important_level) {
            const testCaseEntities = await this.testCaseRepository.find(OperationDescription.from(operationContext), {
                important_level: Number(query.important_level)
            });
            const testCaseIds = testCaseEntities.map(e => e._id);
            uniqTestCaseIds = _.intersection(uniqTestCaseIds, testCaseIds);
            search_condition.test_case_id = { $in: uniqTestCaseIds };
        }
        if (query.type) {
            const testCaseEntities = await this.testCaseRepository.find(OperationDescription.from(operationContext), {
                type: Number(query.type)
            });
            const testCaseIds = testCaseEntities.map(e => e._id);
            uniqTestCaseIds = _.intersection(uniqTestCaseIds, testCaseIds);
            search_condition.test_case_id = { $in: uniqTestCaseIds };
        }
        if (query.suite_id) {
            if (query.suite_id === NULL_SUITE_TEST_CASE_ARG) {
                search_condition.suite_id = null;
            } else {
                search_condition.suite_id = this.parseId(query.suite_id);
            }
        }

        return search_condition;
    }

    public async getTestRunDetail(operationContext: TestRunOperationContext, testRunId: Id) {
        const operationDescription = OperationDescription.from(operationContext);
        let testRun = await this.testRunRepository.findOneById(operationDescription, testRunId, undefined, {
            projection: {
                _id: 1,
                executor_uid: 1,
                priority: 1,
                suite_id: 1,
                status: 1,
                test_case_id: 1,
                steps: 1
            }
        });
        // get test case info
        const testCase = await this.testCaseRepository.findOneById(operationDescription, testRun.test_case_id);
        // get suite info
        let suites = [];
        if (testRun.suite_id) {
            const suite = await this.testSuiteRepository.findOneById(operationDescription, testRun.suite_id);
            suites = await this.testSuiteRepository.findByIds(operationDescription, suite.parent_ids);
            suites = suites.concat(suite);
        }
        // get user info
        const user = await userService.getUserById(operationDescription, testRun.executor_uid);
        return { testRun, testCase, suites, user };
    }

    public async getTestRunColumns(operationContext, testPlanId: Id) {
        const operationDescription = OperationDescription.from(operationContext);
        const result = await this.testRunColumnRepository.findOne(
            operationDescription,
            {
                uid: operationDescription.uid,
                test_plan_id: testPlanId
            },
            false,
            {
                projection: {
                    normal_fields: 1,
                    locked_fields: 1
                }
            }
        );
        const properties = _.values(PROPERTIES);

        return { result, properties };
    }
}
