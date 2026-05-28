import { JdParserService } from './jd-parser.service';

describe('JdParserService', () => {
  const service = new JdParserService();

  it('should parse jd text and keep response shape', async () => {
    const jd = `
      职位名称：高级数据分析师
      工作地点：上海
      薪资：30-45K 14薪
      岗位职责：负责搭建用户增长分析体系，推动自动化报表落地。
      任职要求：本科及以上学历，3-5年数据分析经验，熟悉 SQL / Python / Tableau。
    `;

    const result = await service.parse(jd);

    expect(result).toHaveProperty('basic');
    expect(result).toHaveProperty('responsibilities');
    expect(result).toHaveProperty('requirements.must');
    expect(result).toHaveProperty('requirements.preferred');
    expect(result).toHaveProperty('skills.hardSkills');
    expect(result).toHaveProperty('businessGoals');
    expect(result).toHaveProperty('keywords');
    expect(result).toHaveProperty('seniorityLevel');
    expect(result).toHaveProperty('quality.parseVersion');
    expect(Array.isArray(result.requirements.must)).toBe(true);
  });
});
